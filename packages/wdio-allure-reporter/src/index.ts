import { stringify } from 'csv-stringify/sync'
import WDIOReporter, {
    SuiteStats, Tag, HookStats, RunnerStats, TestStats, BeforeCommandArgs,
    AfterCommandArgs, CommandArgs, Argument
} from '@wdio/reporter'
import type { Capabilities, Options } from '@wdio/types'
import { AllureRuntime, AllureGroup, AllureTest, AllureStep, Status, Stage, LabelName, md5, ContentType } from 'allure-js-commons'

import {
    getTestStatus, isEmpty, tellReporter, isMochaEachHooks, getErrorFromFailedTest,
    isMochaAllHooks, getLinkByTemplate,
} from './utils.js'
import { events, PASSED, FAILED, PENDING, SKIPPED, stepStatuses } from './constants.js'
import {
    AddAttachmentEventArgs, AddDescriptionEventArgs, AddEnvironmentEventArgs,
    AddFeatureEventArgs, AddIssueEventArgs, AddLabelEventArgs, AddSeverityEventArgs,
    AddStoryEventArgs, AddTestIdEventArgs, AllureReporterOptions,
} from './types.js'

class AllureReporter extends WDIOReporter {
    private _allure: AllureRuntime
    private _capabilities: Capabilities.RemoteCapability
    private _isMultiremote?: boolean
    private _config?: Options.Testrunner
    private _lastScreenshot?: string
    private _options: AllureReporterOptions
    private _consoleOutput: string
    private _originalStdoutWrite: Function
    private _addConsoleLogs: boolean
    private _startedSuites: SuiteStats[] = []

    private _runningSuites: Map<string, AllureGroup> = new Map()
    private _runningTests: Map<string, AllureTest | AllureStep> = new Map()

    // TODO:
    private _suite: AllureGroup | undefined
    private _test: AllureTest | undefined
    private _step: AllureStep | undefined
    private _command: AllureStep | undefined

    // private _suites: Map<string, AllureGroup> = new Map()
    // private _tests: Map<string, AllureTest> = new Map()
    // private _steps: Map<string, AllureStep> = new Map()
    // FIXME: better to store all steps in set or array?
    // private _commandSteps: Map<string, AllureStep> = new Map()

    constructor(options: AllureReporterOptions = {}) {
        const outputDir = options.outputDir || 'allure-results'

        super({
            ...options,
            outputDir,
        })
        this._addConsoleLogs = false
        this._consoleOutput = ''
        this._originalStdoutWrite = process.stdout.write.bind(process.stdout)
        this._allure = new AllureRuntime({
            resultsDir: outputDir,
        })
        this._capabilities = {}
        this._options = options

        this.registerListeners()

        this._lastScreenshot = undefined

        let processObj:any = process

        if (options.addConsoleLogs || this._addConsoleLogs) {
            processObj.stdout.write = (chunk: string, encoding: BufferEncoding, callback:  ((err?: Error) => void)) => {
                if (typeof chunk === 'string' && !chunk.includes('mwebdriver')) {
                    this._consoleOutput += chunk
                }
                return this._originalStdoutWrite(chunk, encoding, callback)
            }
        }
    }

    private _attachLogs(unit: AllureTest | AllureStep) {
        if (!this._consoleOutput) return

        const logsContent = `.........Console Logs.........\n\n${this._consoleOutput}`
        const attachmentFilename = this._allure.writeAttachment(logsContent, ContentType.TEXT)

        unit.addAttachment(
            'Console Logs',
            {
                contentType: ContentType.TEXT
            },
            attachmentFilename
        )
    }

    private _attachJSON(unit: AllureTest | AllureStep, name: string, json: any) {
        const content = JSON.stringify(json, null, 2)
        const isStr = typeof json === 'string'
        const contentType = isStr ? ContentType.JSON : ContentType.TEXT
        // TODO: research, when it possible
        const attachmentFilename = this._allure.writeAttachment(isStr ? content : `${content}`, contentType)

        unit.addAttachment(
            name,
            {
                contentType,
            },
            attachmentFilename
        )
    }

    private _attachScreenshot(unit: AllureTest | AllureStep, name: string, content: Buffer) {
        const attachmentFilename = this._allure.writeAttachment(content, ContentType.PNG)

        unit.addAttachment(
            name,
            {
                contentType: ContentType.PNG,
            },
            attachmentFilename
        )
    }

    private _isScreenshotCommand(command: CommandArgs) {
        const isScrenshotEndpoint = /\/session\/[^/]*(\/element\/[^/]*)?\/screenshot/

        return (
            // WebDriver protocol
            (command.endpoint && isScrenshotEndpoint.test(command.endpoint)) ||
            // DevTools protocol
            command.command === 'takeScreenshot'
        )
    }

    registerListeners() {
        process.on(events.addLabel, this.addLabel.bind(this))
        process.on(events.addFeature, this.addFeature.bind(this))
        process.on(events.addStory, this.addStory.bind(this))
        process.on(events.addSeverity, this.addSeverity.bind(this))
        process.on(events.addIssue, this.addIssue.bind(this))
        process.on(events.addTestId, this.addTestId.bind(this))
        process.on(events.addEnvironment, this.addEnvironment.bind(this))
        process.on(events.addAttachment, this.addAttachment.bind(this))
        process.on(events.addDescription, this.addDescription.bind(this))
        process.on(events.startStep, this.startStep.bind(this))
        process.on(events.endStep, this.endStep.bind(this))
        process.on(events.addStep, this.addStep.bind(this))
        process.on(events.addArgument, this.addArgument.bind(this))
    }

    setTestParameters() {
        const currentTest = this._test!

        if (!this._isMultiremote) {
            const caps = this._capabilities as Capabilities.DesiredCapabilities
            const { browserName, deviceName, desired, device } = caps
            let targetName = device || browserName || deviceName

            // custom mobile grids can have device information in a `desired` cap
            if (desired && desired.deviceName && desired.platformVersion) {
                targetName = `${device || desired.deviceName} ${desired.platformVersion}`
            }

            const browserstackVersion = caps.os_version || caps.osVersion
            const version = browserstackVersion || caps.browserVersion || caps.version || caps.platformVersion || ''
            const paramName = (deviceName || device) ? 'device' : 'browser'
            const paramValue = version ? `${targetName}-${version}` : targetName

            currentTest.addParameter(paramName, paramValue || '')
        } else {
            currentTest.addParameter('isMultiremote', 'true')
        }

        currentTest.addLabel(LabelName.LANGUAGE, 'javascript')
        currentTest.addLabel(LabelName.FRAMEWORK, 'wdio')

        if (!this._suite?.name) return

        if (this._options.useCucumberStepReporter) {
            currentTest.addLabel(LabelName.FEATURE, this._suite?.name)
            return
        }

        currentTest.addLabel(LabelName.SUITE, this._suite?.name)
    }

    getParentSuite(uid?: string): SuiteStats | undefined {
        if (!uid) return undefined

        return this._startedSuites.find((suite) => suite.uid === uid)
    }

    getLabels({
        tags
    }: SuiteStats) {
        const labels: { name: string, value: string }[] = []
        if (tags) {
            (tags as Tag[]).forEach((tag: Tag) => {
                const label = tag.name.replace(/[@]/, '').split('=')
                if (label.length === 2) {
                    labels.push({ name: label[0], value: label[1] })
                }
            })
        }
        return labels
    }

    onRunnerStart(runner: RunnerStats) {
        this._config = runner.config
        this._capabilities = runner.capabilities
        this._isMultiremote = runner.isMultiremote || false
    }

    onSuiteStart(suite: SuiteStats) {
        // handle cucumber scenario as AllureTest instead of AllureGroup
        if (this._options.useCucumberStepReporter && suite.type === 'scenario') {
            const hashedTestId = md5(`${suite.uid}:${suite.fullTitle}`)
            const currentTest = this._suite!.startTest(suite.title)

            currentTest.name = suite.title
            currentTest.fullName = suite.fullTitle
            currentTest.testCaseId = hashedTestId
            currentTest.historyId = hashedTestId
            currentTest.description = suite.description
            currentTest.addLabel(LabelName.THREAD, suite.uid)

            this.getLabels(suite).forEach(({ name, value }) => {
                currentTest.addLabel(name, value)
            })
            this._test = currentTest
            this.setTestParameters()
            return
        }

        const currentSuite = new AllureGroup(this._allure)

        if (this._options.useCucumberStepReporter) {
            currentSuite.name = suite.title
        } else {
            const currentSuiteNamePrefix = this._suite ? `${this._suite.name}: ` : ''

            currentSuite.name = `${currentSuiteNamePrefix}${suite.title}`
        }

        this._suite = currentSuite
    }

    onSuiteEnd(suite: SuiteStats) {
        if (!this._options.useCucumberStepReporter || suite.type !== 'scenario') {
            this._suite!.endGroup()
            this._suite = undefined
            return
        }

        const currentTest = this._test!

        // passing hooks are missing the 'state' property
        suite.hooks = suite.hooks!.map((hook) => {
            hook.state = hook.state || PASSED

            return hook
        })

        const isFailed = suite.hooksAndTests.some(item => item.state === FAILED)

        if (isFailed) {
            currentTest.status = Status.FAILED
            currentTest.stage = Stage.FINISHED
            currentTest.endTest()
            this._test = undefined
            return
        }

        const isPassed = !suite.hooksAndTests.some(item => item.state !== PASSED)

        if (isPassed) {
            currentTest.status = Status.PASSED
            currentTest.stage = Stage.FINISHED
            currentTest.endTest()
            this._test = undefined
            return
        }

        // A scenario is it skipped if every steps are skipped and hooks are passed or skipped
        // TODO: could hook be skipped?
        const isSkipped = suite.tests.every(item => item.state === SKIPPED) && suite.hooks.every(item => item.state === PASSED)

        if (isSkipped) {
            currentTest.status = Status.SKIPPED
            currentTest.stage = Stage.PENDING
            currentTest.endTest()
            this._test = undefined
            return
        }

        // A scenario is it passed if certain steps are passed and all other are skipped and every hooks are passed or skipped
        const isPartiallySkipped = suite.hooksAndTests.every(item => item.state === PASSED || item.state === SKIPPED)

        if (isPartiallySkipped) {
            currentTest.status = Status.PASSED
            currentTest.stage = Stage.FINISHED
            currentTest.endTest()
            this._test = undefined
            return
        }
    }

    onTestStart(test: TestStats | HookStats) {
        this._consoleOutput = ''

        // let currentTest = this._tests.get(test.uid)
        const testTitle = test.currentTest ? test.currentTest : test.title

        if (this._test?.name === testTitle) {
            // Test already in progress, most likely started by a before each hook
            this.setTestParameters()
            return
        }

        if (!this._options.useCucumberStepReporter) {
            const hashedTestId = md5(`${test.uid}:${testTitle}`)
            const currentTest = new AllureTest(this._allure)

            currentTest.name = testTitle
            currentTest.testCaseId = hashedTestId
            currentTest.historyId = hashedTestId
            currentTest.addLabel(LabelName.THREAD, test.uid)

            this._test = currentTest
            this.setTestParameters()
            return
        }

        // handle cucumber tests as AllureStep
        const currentStep = this._test!.startStep(test.title)
        const testObj = test as TestStats
        const argument = testObj?.argument as Argument
        const dataTable = argument?.rows?.map((a: { cells: string[] }) => a?.cells)

        if (dataTable) {
            const attachmentFilename = this._allure.writeAttachment(stringify(dataTable), ContentType.CSV)

            currentStep.addAttachment(
                'Data Table',
                {
                    contentType: ContentType.CSV,
                },
                attachmentFilename,
            )
        }

        this._step = currentStep
    }

    onTestPass(test: TestStats | HookStats) {
        if (this._options.useCucumberStepReporter) {

            const currentStep = this._step!

            this._attachLogs(currentStep)

            currentStep.status = Status.PASSED
            currentStep.stage = Stage.FINISHED
            currentStep.endStep()

            this._step = undefined
            return
        }

        const currentTest = this._test!

        this._attachLogs(currentTest)

        currentTest.status = Status.PASSED
        currentTest.stage = Stage.FINISHED
        currentTest.endTest()

        this._test = undefined
    }

    onTestFail(test: TestStats | HookStats) {
        const testError = getErrorFromFailedTest(test)

        if (this._options.useCucumberStepReporter) {
            const currentStep = this._step!

            this._attachLogs(currentStep)

            currentStep.status = Status.FAILED
            currentStep.stage = Stage.FINISHED
            currentStep.detailsMessage = testError?.message
            currentStep.detailsTrace = testError?.stack
            currentStep.endStep()

            this._step = undefined
            return
        }

        const currentTest = this._test!

        this._attachLogs(currentTest)

        currentTest.status = Status.FAILED
        currentTest.stage = Stage.FINISHED
        currentTest.detailsMessage = testError?.message
        currentTest.detailsTrace = testError?.stack
        currentTest.endTest()

        this._test = undefined

        // TODO:
        // if (!this.isAnyTestRunning()) { // is any CASE running
        //     this.onTestStart(test)
        // } else {

        //     this._allure.getCurrentTest().name = test.title
        // }
        // attachConsoleLogs(this._consoleOutput, this._allure)
        // const status = getTestStatus(test, this._config)
        // while (this._allure.getCurrentSuite().currentStep instanceof Step) {
        //     this._allure.endStep(status)
        // }

        // this._allure.endCase(status, getErrorFromFailedTest(test))
    }

    onTestSkip() {
        if (this._options.useCucumberStepReporter) {
            const currentStep = this._step!

            this._attachLogs(currentStep)

            currentStep.status = Status.SKIPPED
            currentStep.stage = Stage.PENDING
            currentStep.endStep()

            this._step = undefined
            return
        }

        const currentTest = this._test!

        this._attachLogs(currentTest)

        currentTest.status = Status.SKIPPED
        currentTest.stage = Stage.PENDING
        currentTest.endTest()
        this._test = undefined
    }

    onBeforeCommand(command: BeforeCommandArgs) {
        const { disableWebdriverStepsReporting } = this._options
        const currentUnit = this._step || this._test

        if (disableWebdriverStepsReporting || this._isMultiremote) return
        if (!currentUnit) return

        const commandPayload = command.body || command.params
        const commandStep = currentUnit.startStep(command.method ? `${command.method} ${command.endpoint}` : command.command as string)

        this._command = commandStep

        if (isEmpty(commandPayload)) return

        this._attachJSON(this._command, 'Request', commandPayload)
    }

    onAfterCommand(command: AfterCommandArgs) {
        const { disableWebdriverStepsReporting, disableWebdriverScreenshotsReporting } = this._options
        const currentUnit = this._step || this._test

        if (!currentUnit) return

        const isScreenshotCommand = this._isScreenshotCommand(command)
        const commandResult = command?.result?.value

        if (!disableWebdriverScreenshotsReporting && isScreenshotCommand && commandResult) {
            this._attachScreenshot(currentUnit, 'Screenshot', Buffer.from(commandResult, 'base64'))
        }

        if (disableWebdriverStepsReporting || this._isMultiremote) return
        if (!this._command) return

        if (commandResult && !isScreenshotCommand) {
            this._attachJSON(this._command, 'Response', commandResult)
        }

        this._command.status = Status.PASSED
        this._command.stage = Stage.FINISHED
        this._command.endStep()
        this._command = undefined
    }

    onHookStart(hook: HookStats) {
        const { disableMochaHooks } = this._options

        // ignore global hooks
        if (!hook.parent || !this._suite) return

        const mochaAllHook = isMochaAllHooks(hook.title)
        const mochaEachHook = isMochaEachHooks(hook.title)

        // don't add hook as test to suite for mocha All hooks
        if (disableMochaHooks && mochaAllHook) return

        // add beforeEach / afterEach hook as step to test
        if (disableMochaHooks && mochaEachHook && this._test) {
            this._step = this._test.startStep(hook.title)
            return
        }

        // add hook as test to suite
        this.onTestStart(hook)
    }

    onHookEnd(hook: HookStats) {
        const { disableMochaHooks } = this._options

        // ignore global hooks
        if (!hook.parent || !this._suite) return

        const mochaAllHook = isMochaAllHooks(hook.title)
        const mochaEachHook = isMochaEachHooks(hook.title)

        if (!this._test && disableMochaHooks && !mochaAllHook) return

        // set beforeEach / afterEach hook (step) status
        if (disableMochaHooks && mochaEachHook) {
            const currentStep = this._step!

            if (hook.error) {
                currentStep.status = Status.FAILED
                currentStep.detailsMessage = hook.error.message
                currentStep.detailsTrace = hook.error?.stack
            } else {
                currentStep.status = Status.PASSED
            }

            currentStep.stage = Stage.FINISHED
            currentStep.endStep()
            this._step = undefined
            return
        }

        // set hook (test) status
        if (hook.error) {
            if (disableMochaHooks && mochaAllHook) {
                this.onTestStart(hook)
            }

            this.onTestFail(hook)
            return
        }

        // TODO: new allure version doesn't allow direct access to the test steps
        // if ((disableMochaHooks || useCucumberStepReporter) && !mochaAllHook) {
        //     // remove hook from suite if it has no steps
        //     // if (this._test.steps.length === 0 && !useCucumberStepReporter) {
        //     //     this._suite.testcases.pop()
        //     // } else if (this._options.useCucumberStepReporter) {
        //     //     // remove hook when it's registered as a step and if it's passed
        //     //     const step = this._test.steps.pop()

        //     //     // if it had any attachments, reattach them to current test
        //     //     if (step && step.attachments.length >= 1) {
        //     //         step.attachments.forEach((attachment: any) => {
        //     //             this._test.addAttachment(attachment)
        //     //         })
        //     //     }
        //     // }
        // }

        this.onTestPass(hook)
    }

    addLabel({
        name,
        value
    }: AddLabelEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.addLabel(name, value)
    }

    addStory({
        storyName
    }: AddStoryEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.addLabel('story', storyName)
    }

    addFeature({
        featureName
    }: AddFeatureEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.addLabel('feature', featureName)
    }

    addSeverity({
        severity
    }: AddSeverityEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.addLabel('severity', severity)
    }

    addIssue({
        issue
    }: AddIssueEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        const issueLink = getLinkByTemplate(this._options.issueLinkTemplate, issue)
        test.addLabel('issue', issueLink)
    }

    addTestId({
        testId
    }: AddTestIdEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        const tmsLink = getLinkByTemplate(this._options.tmsLinkTemplate, testId)
        test.addLabel('testId', tmsLink)
    }

    addEnvironment({
        name,
        value
    }: AddEnvironmentEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.addParameter('environment-variable', name, value)
    }

    addDescription({
        description,
        descriptionType
    }: AddDescriptionEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.setDescription(description, descriptionType)
    }

    addAttachment({
        name,
        content,
        type = 'text/plain'
    }: AddAttachmentEventArgs) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        if (type === 'application/json') {
            this.dumpJSON(name, content as object)
        } else {
            this._allure.addAttachment(name, Buffer.from(content as string), type)
        }
    }

    startStep(title: string) {
        if (!this.isAnyTestRunning()) {
            return false
        }
        this._allure.startStep(title)
    }

    endStep(status: Status) {
        if (!this.isAnyTestRunning()) {
            return false
        }
        this._allure.endStep(status)
    }

    addStep({
        step
    }: any) {
        if (!this.isAnyTestRunning()) {
            return false
        }
        this.startStep(step.title)
        if (step.attachment) {
            this.addAttachment(step.attachment)
        }
        this.endStep(step.status)
    }

    addArgument({
        name,
        value
    }: any) {
        if (!this.isAnyTestRunning()) {
            return false
        }

        const test = this._allure.getCurrentTest()
        test.addParameter('argument', name, value)
    }

    isAnyTestRunning() {
        return this._allure.getCurrentSuite() && this._allure.getCurrentTest()
    }

    isScreenshotCommand(command: CommandArgs) {
        const isScrenshotEndpoint = /\/session\/[^/]*(\/element\/[^/]*)?\/screenshot/
        return (
            // WebDriver protocol
            (command.endpoint && isScrenshotEndpoint.test(command.endpoint)) ||
            // DevTools protocol
            command.command === 'takeScreenshot'
        )
    }

    dumpJSON(name: string, json: object) {
        const content = JSON.stringify(json, null, 2)
        const isStr = typeof content === 'string'
        this._allure.addAttachment(name, isStr ? content : `${content}`, isStr ? 'application/json' : 'text/plain')
    }

    attachScreenshot() {
        if (this._lastScreenshot && !this._options.disableWebdriverScreenshotsReporting) {
            this._allure.addAttachment('Screenshot', Buffer.from(this._lastScreenshot, 'base64'))
            this._lastScreenshot = undefined
        }
    }

    /**
     * Assign feature to test
     * @name addFeature
     * @param {(string)} featureName - feature name or an array of names
     */
    static addFeature = (featureName: string) => {
        tellReporter(events.addFeature, { featureName })
    }

    /**
     * Assign label to test
     * @name addLabel
     * @param {string} name - label name
     * @param {string} value - label value
     */
    static addLabel = (name: string, value: string) => {
        tellReporter(events.addLabel, { name, value })
    }
    /**
     * Assign severity to test
     * @name addSeverity
     * @param {string} severity - severity value
     */
    static addSeverity = (severity: string) => {
        tellReporter(events.addSeverity, { severity })
    }

    /**
     * Assign issue id to test
     * @name addIssue
     * @param {string} issue - issue id value
     */
    static addIssue = (issue: string) => {
        tellReporter(events.addIssue, { issue })
    }

    /**
     * Assign TMS test id to test
     * @name addTestId
     * @param {string} testId - test id value
     */
    static addTestId = (testId: string) => {
        tellReporter(events.addTestId, { testId })
    }

    /**
     * Assign story to test
     * @name addStory
     * @param {string} storyName - story name for test
     */
    static addStory = (storyName: string) => {
        tellReporter(events.addStory, { storyName })
    }

    /**
     * Add environment value
     * @name addEnvironment
     * @param {string} name - environment name
     * @param {string} value - environment value
     */
    static addEnvironment = (name: string, value: string) => {
        tellReporter(events.addEnvironment, { name, value })
    }

    /**
     * Assign test description to test
     * @name addDescription
     * @param {string} description - description for test
     * @param {string} descriptionType - description type 'text'\'html'\'markdown'
     */
    static addDescription = (description: string, descriptionType: string) => {
        tellReporter(events.addDescription, { description, descriptionType })
    }

    /**
     * Add attachment
     * @name addAttachment
     * @param {string} name         - attachment file name
     * @param {*} content           - attachment content
     * @param {string=} mimeType    - attachment mime type
     */
    static addAttachment = (name: string, content: string | Buffer | object, type: string) => {
        if (!type) {
            type = content instanceof Buffer ? 'image/png' : typeof content === 'string' ? 'text/plain' : 'application/json'
        }
        tellReporter(events.addAttachment, { name, content, type })
    }

    /**
     * Start allure step
     * @name startStep
     * @param {string} title - step name in report
     */
    static startStep = (title: string) => {
        tellReporter(events.startStep, title)
    }

    /**
     * End current allure step
     * @name endStep
     * @param {StepStatus} [status='passed'] - step status
     */
    static endStep = (status: Status = 'passed') => {
        if (!Object.values(stepStatuses).includes(status)) {
            throw new Error(`Step status must be ${Object.values(stepStatuses).join(' or ')}. You tried to set "${status}"`)
        }
        tellReporter(events.endStep, status)
    }

    /**
     * Create allure step
     * @name addStep
     * @param {string} title - step name in report
     * @param {Object} [attachmentObject={}] - attachment for step
     * @param {string} attachmentObject.content - attachment content
     * @param {string} [attachmentObject.name='attachment'] - attachment name
     * @param {string} [attachmentObject.type='text/plain'] - attachment type
     * @param {string} [status='passed'] - step status
     */
    static addStep = (title: string, {
        content,
        name = 'attachment',
        type = 'text/plain'
    }: any = {}, status: Status = 'passed') => {
        if (!Object.values(stepStatuses).includes(status)) {
            throw new Error(`Step status must be ${Object.values(stepStatuses).join(' or ')}. You tried to set "${status}"`)
        }

        const step = content ? { title, attachment: { content, name, type }, status } : { title, status }
        tellReporter(events.addStep, { step })
    }

    /**
     * Add additional argument to test
     * @name addArgument
     * @param {string} name - argument name
     * @param {string} value - argument value
     */
    static addArgument = (name: string, value: string) => {
        tellReporter(events.addArgument, { name, value })
    }
}

export default AllureReporter

export { AllureReporterOptions }
export * from './types.js'

declare global {
    namespace WebdriverIO {
        interface ReporterOption extends AllureReporterOptions { }
    }
}
