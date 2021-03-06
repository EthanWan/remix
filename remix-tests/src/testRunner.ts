import async from 'async'
import * as changeCase from 'change-case'
import Web3 = require('web3')
import { RunListInterface, TestCbInterface, TestResultInterface, ResultCbInterface,
    CompiledContract, AstNode, Options, FunctionDescription, UserDocumentation } from './types'

function getFunctionFullName (signature: string, methodIdentifiers: Record <string, string>) {
    for (const method in methodIdentifiers) {
        if (signature.replace('0x', '') === methodIdentifiers[method].replace('0x', '')) {
            return method
        }
    }
    return null
}

function getOverridedSender (userdoc: UserDocumentation, signature: string, methodIdentifiers: Record <string, string>) {
    let fullName: any = getFunctionFullName(signature, methodIdentifiers)
    let match: RegExp = /sender: account-+(\d)/g
    let accountIndex: any = userdoc.methods[fullName] ? match.exec(userdoc.methods[fullName].notice) : null
    return fullName && accountIndex ? accountIndex[1] : null
}

/**
 * @dev returns functions of a test contract file in same sequence they appear in file (using passed AST)
 * @param fileAST AST of test contract file source
 * @param testContractName Name of test contract
 */

function getAvailableFunctions (fileAST: AstNode, testContractName: string) {
    let funcList: string[] = []
    if(fileAST.nodes && fileAST.nodes.length > 0) {
        const contractAST: AstNode[] = fileAST.nodes.filter(node => node.name === testContractName && node.nodeType === 'ContractDefinition')
        if(contractAST.length > 0 && contractAST[0].nodes) {
            const funcNodes: AstNode[] = contractAST[0].nodes.filter(node => node.kind === 'function' && node.nodeType === "FunctionDefinition")
            funcList = funcNodes.map(node => node.name)
        }
    }
    return funcList;
}

/**
 * @dev returns ABI of passed method list from passed interface
 * @param jsonInterface Json Interface
 * @param funcList Methods to extract the interface of
 */

function getTestFunctionsInterface (jsonInterface: FunctionDescription[], funcList: string[]) {
    const functionsInterface: any[] = []
    const specialFunctions = ['beforeAll', 'beforeEach', 'afterAll', 'afterEach']
    for(const func of funcList){
        if(!specialFunctions.includes(func)) {
            const funcInterface= jsonInterface.find(node => node.type === 'function' && node.name === func)
            functionsInterface.push(funcInterface)
        }
    }
    return functionsInterface
}

/**
 * @dev Prepare a list of tests to run using test contract file ABI, AST & contract name
 * @param jsonInterface File JSON interface
 * @param fileAST File AST
 * @param testContractName Test contract name
 */

function createRunList (jsonInterface: FunctionDescription[], fileAST: AstNode, testContractName: string): RunListInterface[] {
    const availableFunctions: string[] = getAvailableFunctions(fileAST, testContractName)
    const testFunctionsInterface: any[] = getTestFunctionsInterface(jsonInterface, availableFunctions)

    let runList: RunListInterface[] = []

    if (availableFunctions.indexOf('beforeAll') >= 0) {
        runList.push({ name: 'beforeAll', type: 'internal', constant: false })
    }

    for (const func of testFunctionsInterface) {
        if (availableFunctions.indexOf('beforeEach') >= 0) {
            runList.push({ name: 'beforeEach', type: 'internal', constant: false })
        }
        runList.push({ name: func.name, signature: func.signature, type: 'test', constant: func.constant })
        if (availableFunctions.indexOf('afterEach') >= 0) {
            runList.push({ name: 'afterEach', type: 'internal', constant: false })
        }
    }

    if (availableFunctions.indexOf('afterAll') >= 0) {
        runList.push({ name: 'afterAll', type: 'internal', constant: false })
    }

    return runList
}

export function runTest (testName: string, testObject: any, contractDetails: CompiledContract, fileAST: AstNode, opts: Options, testCallback: TestCbInterface, resultsCallback: ResultCbInterface) {
    const runList: RunListInterface[] = createRunList(testObject._jsonInterface, fileAST, testName)
    let passingNum: number = 0
    let failureNum: number = 0
    let timePassed: number = 0
    const web3 = new Web3()

    const accts: TestResultInterface = {
      type: 'accountList',
      value: opts.accounts
    }

    testCallback(undefined, accts);

    const resp: TestResultInterface = {
      type: 'contract',
      value: testName,
      filename: testObject.filename
    }

    testCallback(undefined, resp)
    async.eachOfLimit(runList, 1, function (func, index, next) {
        let sender
        if (func.signature) {
            sender = getOverridedSender(contractDetails.userdoc, func.signature, contractDetails.evm.methodIdentifiers)
            if (opts.accounts) {
                sender = opts.accounts[sender]
            }
        }
        let sendParams
        if (sender) sendParams = { from: sender }

        const method = testObject.methods[func.name].apply(testObject.methods[func.name], [])
        const startTime = Date.now()
        if (func.constant) {
            method.call(sendParams).then((result) => {
                const time = (Date.now() - startTime) / 1000.0
                if (result) {
                    const resp: TestResultInterface = {
                      type: 'testPass',
                      value: changeCase.sentenceCase(func.name),
                      time: time,
                      context: testName
                    }
                    testCallback(undefined, resp)
                    passingNum += 1
                    timePassed += time
                } else {
                    const resp: TestResultInterface = {
                      type: 'testFailure',
                      value: changeCase.sentenceCase(func.name),
                      time: time,
                      errMsg: 'function returned false',
                      context: testName
                    }
                    testCallback(undefined, resp)
                    failureNum += 1
                }
                next()
            })
        } else {
            method.send(sendParams).on('receipt', (receipt) => {
                try {
                    const time: number = (Date.now() - startTime) / 1000.0
                    const topic = Web3.utils.sha3('AssertionEvent(bool,string)')
                    let testPassed: boolean = false

                    for (const i in receipt.events) {
                        const event = receipt.events[i]
                        if (event.raw.topics.indexOf(topic) >= 0) {
                            const testEvent = web3.eth.abi.decodeParameters(['bool', 'string'], event.raw.data)
                            if (!testEvent[0]) {
                                const resp: TestResultInterface = {
                                  type: 'testFailure',
                                  value: changeCase.sentenceCase(func.name),
                                  time: time,
                                  errMsg: testEvent[1],
                                  context: testName
                                };
                                testCallback(undefined, resp)
                                failureNum += 1
                                return next()
                            }
                            testPassed = true
                        }
                    }

                    if (testPassed) {
                        const resp: TestResultInterface = {
                          type: 'testPass',
                          value: changeCase.sentenceCase(func.name),
                          time: time,
                          context: testName
                        }
                        testCallback(undefined, resp)
                        passingNum += 1
                    }

                    return next()
                } catch (err) {
                    console.error(err)
                    return next(err)
                }
            }).on('error', function (err: any) {
                console.error(err)
                const time: number = (Date.now() - startTime) / 1000.0
                const resp: TestResultInterface = {
                    type: 'testFailure',
                    value: changeCase.sentenceCase(func.name),
                    time: time,
                    errMsg: err.message,
                    context: testName
                  };
                  testCallback(undefined, resp)
                  failureNum += 1
                return next()
            })
        }
    }, function(error) {
        resultsCallback(error, {
            passingNum: passingNum,
            failureNum: failureNum,
            timePassed: timePassed
        })
    })
}
