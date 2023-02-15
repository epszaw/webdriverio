import { stringify } from 'csv-stringify/sync'
import type {
    SuiteStats, Tag, HookStats, RunnerStats, TestStats, BeforeCommandArgs,
    AfterCommandArgs, CommandArgs, Argument
} from '@wdio/reporter'
import WDIOReporter from '@wdio/reporter'
import type { Capabilities, Options } from '@wdio/types'
import { AllureRuntime, AllureGroup, AllureTest, AllureStep, Status as AllureStatus, Stage, LabelName, LinkType, ContentType } from 'allure-js-commons'
import {
    addFeature, addLink, addOwner, addEpic, addSuite, addSubSuite, addParentSuite, addTag, addLabel, addSeverity, addIssue, addTestId, addStory, addEnvironment, addAllureId,
    addDescription, addAttachment, startStep, endStep, addStep, addArgument
} from './common/api.js'
import {
    getTestStatus, isEmpty, isMochaEachHooks, getErrorFromFailedTest,
    isMochaAllHooks, getLinkByTemplate, findLast, takeWhile,
} from './utils.js'
import { events } from './constants.js'
import type {
    AddAttachmentEventArgs, AddDescriptionEventArgs, AddEnvironmentEventArgs,
    AddFeatureEventArgs, AddIssueEventArgs, AddLabelEventArgs, AddSeverityEventArgs,
    AddEpicEventArgs, AddOwnerEventArgs, AddParentSuiteEventArgs, AddSubSuiteEventArgs,
    AddLinkEventArgs, AddAllureIdEventArgs, AddSuiteEventArgs, AddTagEventArgs,
    AddStoryEventArgs, AddTestIdEventArgs, AllureReporterOptions } from './types.js'
import {
    TYPE as DescriptionType
} from './types.js'

export default class AllureReporter extends WDIOReporter {
    private _allure: AllureRuntime
    private _capabilities: Capabilities.RemoteCapability
    private _isMultiremote?: boolean
    private _config?: Options.Testrunner
    private _options: AllureReporterOptions
    private _consoleOutput: string
    private _originalStdoutWrite: Function

    // TODO: i guess better to rename the property to make it easy to understand that we actually work with stack
    _runningUnits: Array<AllureGroup | AllureTest | AllureStep> = []

    constructor(options: AllureReporterOptions = {}) {
        const { outputDir = 'allure-results', ...rest } = options

        super({
            ...rest,
            outputDir,
        })
        this._consoleOutput = ''
        this._originalStdoutWrite = process.stdout.write.bind(process.stdout)
        this._allure = new AllureRuntime({
            resultsDir: outputDir,
        })
        this._capabilities = {}
        this._options = options

        this.registerListeners()

        const processObj:any = process

        if (options.addConsoleLogs) {
            processObj.stdout.write = (chunk: string, encoding: BufferEncoding, callback:  ((err?: Error) => void)) => {
                if (typeof chunk === 'string' && !chunk.includes('mwebdriver')) {
                    this._consoleOutput += chunk
                }

                return this._originalStdoutWrite(chunk, encoding, callback)
            }
        }
    }

    get currentSuite(): AllureGroup | undefined {
        return findLast(this._runningUnits, (unit) => unit instanceof AllureGroup) as AllureGroup | undefined
    }

    get currentTest(): AllureTest | undefined {
        return findLast(this._runningUnits, (unit) => unit instanceof AllureTest) as AllureTest | undefined
    }

    get currentStep(): AllureStep | undefined {
        return findLast(this._runningUnits, (unit) => unit instanceof AllureStep) as AllureStep | undefined
    }

    // TODO: review the method purporse
    get currentTestSteps(): AllureStep[] {
        if (!this.currentTest) {
            return []
        }

        const currentTestIdx = this._runningUnits.findIndex(unit => unit === this.currentTest)

        return takeWhile(
            this._runningUnits.slice(currentTestIdx + 1),
            (el: AllureGroup | AllureTest | AllureStep) => el instanceof AllureStep,
        ) as AllureStep[]
    }

    get currentAllureSpec(): AllureTest | AllureStep | undefined {
        return findLast(this._runningUnits, (unit) => unit instanceof AllureTest || unit instanceof AllureStep) as AllureTest | AllureStep | undefined
    }

    attachLogs() {
        if (!this._consoleOutput || !this.currentAllureSpec) {
            return
        }

        const logsContent = `.........Console Logs.........\n\n${this._consoleOutput}`
        const attachmentFilename = this._allure.writeAttachment(logsContent, ContentType.TEXT)

        this.currentAllureSpec.addAttachment(
            'Console Logs',
            {
                contentType: ContentType.TEXT,
            },
            attachmentFilename,
        )
    }

    attachFile(name: string, content: string | Buffer, contentType: ContentType) {
        if (!this.currentAllureSpec) {
            throw new Error("There isn't any active test!")
        }

        const attachmentFilename = this._allure.writeAttachment(content, contentType)

        this.currentAllureSpec.addAttachment(
            name,
            {
                contentType,
            },
            attachmentFilename
        )
    }

    attachJSON(name: string, json: any) {
        const isStr = typeof json === 'string'
        const content = isStr ? json : JSON.stringify(json, null, 2)

        this.attachFile(name, String(content), isStr ? ContentType.JSON : ContentType.TEXT)
    }

    attachScreenshot(name: string, content: Buffer) {
        this.attachFile(name, content, ContentType.PNG)
    }

    _startSuite(suiteTitle: string) {
        const newSuite: AllureGroup = this.currentSuite ? this.currentSuite.startGroup() : new AllureGroup(this._allure)

        newSuite.name = suiteTitle

        this._runningUnits.push(newSuite)
    }

    _endSuite() {
        if (!this.currentSuite) {
            throw new Error("There isn't any active suite!")
        }

        while (this.currentAllureSpec) {
            const currentTest = this._runningUnits.pop() as AllureTest | AllureStep

            if (currentTest instanceof AllureTest) {
                currentTest.endTest()
            } else {
                currentTest.endStep()
            }
        }

        const currentSuite = this._runningUnits.pop() as AllureGroup

        currentSuite.endGroup()
    }

    _startTest(testTitle: string, cid?: string) {
        const newTest = this.currentSuite ? this.currentSuite.startTest() : new AllureTest(this._allure)

        newTest.name = testTitle

        this._runningUnits.push(newTest)
        this.setCaseParameters(cid)
    }

    _skipTest() {
        if (!this.currentAllureSpec) {
            return
        }

        const currentTest = this._runningUnits.pop() as AllureTest | AllureStep

        currentTest.stage = Stage.PENDING
        currentTest.status = AllureStatus.SKIPPED

        if (currentTest instanceof AllureTest) {
            currentTest.endTest()
        } else {
            currentTest.endStep()
        }
    }

    _endTest(status: AllureStatus, error?: Error) {
        if (!this.currentAllureSpec) {
            return
        }

        const currentSpec = this._runningUnits.pop() as AllureTest | AllureStep

        // TODO: we need to end all children steps
        // if (currentSpec instanceof AllureTest) {
        //     while (this.currentTestSteps().length > 0) {
        //         this._endTest(status)
        //         // console.log('running steps', this.currentTestSteps.length)

        //         // const currentStep = this._runningUnits.pop() as AllureStep

        //         // currentStep.stage = Stage.FINISHED
        //         // currentStep.status = status
        //         // currentStep.endStep()
        //     }
        // }

        currentSpec.stage = Stage.FINISHED
        currentSpec.status = status

        if (error) {
            currentSpec.detailsMessage = error.message
            currentSpec.detailsTrace = error.stack
        }

        if (currentSpec instanceof AllureTest) {
            currentSpec.endTest()
        } else {
            currentSpec.endStep()
        }
    }

    _startStep(testTitle: string) {
        if (!this.currentAllureSpec) {
            throw new Error("There isn't any active test!")
        }

        const newStep = this.currentAllureSpec!.startStep(testTitle)

        this._runningUnits.push(newStep)
    }

    // TODO
    // setCaseParameters(cid: string | undefined, parentUid: string | undefined, addFeatureLabel: boolean = true ) {
    //     const parentSuite = this.getParentSuite(parentUid)
    //     const currentTest = this._allure.getCurrentTest()

    //     if (!this._isMultiremote) {
    //         const caps = this._capabilities as Capabilities.DesiredCapabilities
    //         const { browserName, deviceName, desired, device } = caps
    //         let targetName = device || browserName || deviceName || cid
    //         // custom mobile grids can have device information in a `desired` cap
    //         if (desired && desired.deviceName && desired.platformVersion) {
    //             targetName = `${device || desired.deviceName} ${desired.platformVersion}`
    //         }
    //         const browserstackVersion = caps.os_version || caps.osVersion
    //         const version = browserstackVersion || caps.browserVersion || caps.version || caps.platformVersion || ''
    //         const paramName = (deviceName || device) ? 'device' : 'browser'
    //         const paramValue = version ? `${targetName}-${version}` : targetName
    //         currentTest.addParameter('argument', paramName, paramValue)
    //     } else {
    //         currentTest.addParameter('argument', 'isMultiremote', 'true')
    //     }

    //     // Allure analytics labels. See https://github.com/allure-framework/allure2/blob/master/Analytics.md
    //     currentTest.addLabel('language', 'javascript')
    //     currentTest.addLabel('framework', 'wdio')
    //     currentTest.addLabel('thread', cid)

    //     if (addFeatureLabel && parentSuite) {
    //         const labelValue = this.getLabels(parentSuite).find(label => label.name === 'feature')?.value ?? parentSuite.title
    //         if (labelValue) {
    //             currentTest.addLabel('feature', labelValue)
    //         }
    //     }
    // }

    setCaseParameters(cid: string | undefined) {
        if (!this.currentTest) {
            return
        }

        if (!this._isMultiremote) {
            const caps = this._capabilities as Capabilities.DesiredCapabilities
            const { browserName, deviceName, desired, device } = caps
            let targetName = device || browserName || deviceName || cid

            // custom mobile grids can have device information in a `desired` cap
            if (desired && desired.deviceName && desired.platformVersion) {
                targetName = `${device || desired.deviceName} ${desired.platformVersion}`
            }

            const browserstackVersion = caps.os_version || caps.osVersion
            const version = browserstackVersion || caps.browserVersion || caps.version || caps.platformVersion || ''
            const paramName = (deviceName || device) ? 'device' : 'browser'
            const paramValue = version ? `${targetName}-${version}` : targetName

            if (!paramValue) {
                return
            }

            this.currentTest.addParameter(paramName, paramValue)
        } else {
            this.currentTest.addParameter('isMultiremote', 'true')
        }

        // Allure analytics labels. See https://github.com/allure-framework/allure2/blob/master/Analytics.md
        this.currentTest.addLabel('language', 'javascript')
        this.currentTest.addLabel('framework', 'wdio')

        if (cid) {
            this.currentTest.addLabel('thread', cid)
        }

        if (this.currentSuite?.name) {
            this.currentTest.addLabel('feature', this.currentSuite.name)
        }
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

    registerListeners() {
        process.on(events.addLink, this.addLink.bind(this))
        process.on(events.addLabel, this.addLabel.bind(this))
        process.on(events.addAllureId, this.addAllureId.bind(this))
        process.on(events.addFeature, this.addFeature.bind(this))
        process.on(events.addStory, this.addStory.bind(this))
        process.on(events.addSeverity, this.addSeverity.bind(this))
        process.on(events.addSuite, this.addSuite.bind(this))
        process.on(events.addSubSuite, this.addSubSuite.bind(this))
        process.on(events.addOwner, this.addOwner.bind(this))
        process.on(events.addTag, this.addTag.bind(this))
        process.on(events.addParentSuite, this.addParentSuite.bind(this))
        process.on(events.addEpic, this.addEpic.bind(this))
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

    onRunnerStart(runner: RunnerStats) {
        this._config = runner.config
        this._capabilities = runner.capabilities
        this._isMultiremote = runner.isMultiremote || false
    }

    onSuiteStart(suite: SuiteStats) {
        const { useCucumberStepReporter } = this._options
        const isScenario = suite.type === 'scenario'
        const isFeature = suite.type === 'feature'

        // if (!this._options.useCucumberStepReporter) {
        //     const currentSuite = this._allure.getCurrentSuite()
        //     const prefix = currentSuite ? currentSuite.name + ': ' : ''

        //     this._allure.startSuite(prefix + suite.title)
        //     return
        // }

        // // handle cucumber features as allure "suite"
        // if (isFeature) {
        //     // temp solution to keep suites stats index for saving allure test ops feature based structure
        //     this._startedFeatures.push(suite)
        //     this._allure.startSuite(suite.title)
        //     return
        // }

        // // handle cucumber scenario as allure "case" instead of "suite"
        // this._allure.startCase(suite.title)

        // const currentTest = this._allure.getCurrentTest()

        // let featureLabelPresent = false

        // this.getLabels(suite).forEach(({ name, value }) => {
        //     if (name === 'issue') {
        //         this.addIssue({ issue: value })
        //     } else if (name === 'testId') {
        //         this.addTestId({ testId: value })
        //     } else {
        //         if (name === 'feature') {
        //             featureLabelPresent = true
        //         }
        //         currentTest.addLabel(name, value)
        //     }
        // })

        if (useCucumberStepReporter && isScenario) {
            // handle cucumber scenario as allure "case" instead of "suite"
            this._startTest(suite.title, suite.cid)
            this.getLabels(suite).forEach(({ name, value }) => {
                if (name === 'issue') {
                    this.addIssue({ issue: value })
                } else if (name === 'testId') {
                    this.addTestId({ testId: value })
                } else {
                    this.addLabel({ name, value })
                }
            })

            if (suite.description) {
                this.addDescription(suite)
            }
            return
        }

        const prefix = this.currentSuite ? this.currentSuite.name + ': ' : ''
        const suiteTitle = isFeature ? suite.title : prefix + suite.title

        this._startSuite(suiteTitle)
        // this.setCaseParameters(suite.cid, suite.parent, !featureLabelPresent)
    }

    onSuiteEnd(suite: SuiteStats) {
        const { useCucumberStepReporter } = this._options
        const isScenario = suite.type === 'scenario'

        if (useCucumberStepReporter && isScenario) {
            // passing hooks are missing the 'state' property
            suite.hooks = suite.hooks!.map((hook) => {
                hook.state = hook.state || AllureStatus.PASSED
                return hook
            })

            const suiteChildren = [...suite.tests!, ...suite.hooks]

            // A scenario is it skipped if every steps are skipped and hooks are passed or skipped
            const isSkipped = suite.tests.every(item => [AllureStatus.SKIPPED].includes(item.state as AllureStatus)) && suite.hooks.every(item => [AllureStatus.PASSED, AllureStatus.SKIPPED].includes(item.state as AllureStatus))

            if (isSkipped) {
                const currentTest = this._runningUnits.pop() as AllureTest

                currentTest.status = AllureStatus.SKIPPED
                currentTest.stage = Stage.PENDING
                currentTest.endTest()
                return
            }

            const isFailed = suiteChildren.some(item => item.state === AllureStatus.FAILED)

            if (isFailed) {
                const currentTest = this._runningUnits.pop() as AllureTest

                currentTest.status = AllureStatus.FAILED
                currentTest.stage = Stage.FINISHED
                currentTest.endTest()
                return
            }

            const isPassed = suiteChildren.every(item => item.state === AllureStatus.PASSED)
            // A scenario is it passed if certain steps are passed and all other are skipped and every hooks are passed or skipped
            const isPartiallySkipped = suiteChildren.every(item => [AllureStatus.PASSED, AllureStatus.SKIPPED].includes(item.state as AllureStatus))

            if (isPassed || isPartiallySkipped) {
                const currentTest = this._runningUnits.pop() as AllureTest

                currentTest.status = AllureStatus.PASSED
                currentTest.stage = Stage.FINISHED
                currentTest.endTest()
                return
            }

            // Only close passing and skipped tests because
            // failing tests are closed in onTestFailed event
            return
        }

        this._endSuite()
    }

    onTestStart(test: TestStats | HookStats) {
        const { useCucumberStepReporter } = this._options

        this._consoleOutput = ''

        const testTitle = test.currentTest ? test.currentTest : test.title

        if (this.currentAllureSpec?.wrappedItem.name === testTitle) {
            // Test already in progress, most likely started by a before each hook
            this.setCaseParameters(test.cid)
            return
        }

        if (useCucumberStepReporter) {
            const testObj = test as TestStats
            const argument = testObj?.argument as Argument
            const dataTable = argument?.rows?.map((a: { cells: string[] }) => a?.cells)

            this._startStep(testTitle)

            if (dataTable) {
                this.attachFile('Data Table', stringify(dataTable), ContentType.CSV)
            }
            return
        }

        this._startTest(testTitle, test.cid)
    }

    onTestPass() {
        this.attachLogs()
        this._endTest(AllureStatus.PASSED)
    }

    onTestFail(test: TestStats | HookStats) {
        const { useCucumberStepReporter } = this._options

        if (useCucumberStepReporter) {
            this.attachLogs()

            const testStatus = getTestStatus(test, this._config)

            this._endTest(testStatus, getErrorFromFailedTest(test))
            return
        }

        if (!this.currentAllureSpec) {
            this.onTestStart(test)
        } else {
            this.currentAllureSpec.name = test.title
        }

        this.attachLogs()

        const status = getTestStatus(test, this._config)

        this._endTest(status, getErrorFromFailedTest(test))
    }

    onTestSkip(test: TestStats) {
        this.attachLogs()

        if (!this.currentAllureSpec || this.currentAllureSpec.wrappedItem.name !== test.title) {
            this._startTest(test.title, test.cid)
            this._skipTest()
            return
        }

        this._skipTest()
    }

    onBeforeCommand(command: BeforeCommandArgs) {
        if (!this.currentAllureSpec) {
            return
        }

        const { disableWebdriverStepsReporting } = this._options

        if (disableWebdriverStepsReporting || this._isMultiremote) {
            return
        }

        this._startStep(command.method ? `${command.method} ${command.endpoint}` : command.command as string)

        const payload = command.body || command.params

        if (!isEmpty(payload)) {
            this.attachJSON('Request', payload)
        }
    }

    onAfterCommand(command: AfterCommandArgs) {
        const { disableWebdriverStepsReporting, disableWebdriverScreenshotsReporting } = this._options

        if (disableWebdriverStepsReporting || !this.currentAllureSpec || this._isMultiremote) {
            return
        }

        const isScreenshotCommand = this.isScreenshotCommand(command)
        const { value: commandResult } = command?.result || {}

        if (!disableWebdriverScreenshotsReporting && isScreenshotCommand && commandResult) {
            this.attachScreenshot('Screenshot', Buffer.from(commandResult, 'base64'))
        }

        if (!isScreenshotCommand && commandResult) {
            this.attachJSON('Response', commandResult)
        }

        this._endTest(AllureStatus.PASSED)
    }

    onHookStart(hook: HookStats) {
        const { disableMochaHooks } = this._options

        // ignore global hooks
        if (!hook.parent || !this.currentSuite) {
            return
        }

        const isMochaAllHook = isMochaAllHooks(hook.title)
        const isMochaEachHook = isMochaEachHooks(hook.title)

        // don't add hook as test to suite for mocha each hooks if no current test
        if (disableMochaHooks && isMochaEachHook && !this.currentAllureSpec) {
            return
        }

        // add beforeEach / afterEach hook as step to test
        if (disableMochaHooks && isMochaEachHook && this.currentAllureSpec) {
            this._startStep(hook.title)
            return
        }

        // don't add hook as test to suite for mocha All hooks
        if (disableMochaHooks && isMochaAllHook) {
            return
        }

        // add hook as test to suite
        this.onTestStart(hook)
    }

    onHookEnd(hook: HookStats) {
        const { disableMochaHooks } = this._options

        // ignore global hooks
        if (!hook.parent || !this.currentSuite) {
            return
        }

        const isMochaAllHook = isMochaAllHooks(hook.title)
        const isMochaEachHook = isMochaEachHooks(hook.title)

        if (disableMochaHooks && !isMochaAllHook && !this.currentAllureSpec) {
            return
        }

        // set beforeEach / afterEach hook (step) status
        if (disableMochaHooks && isMochaEachHook) {
            this._endTest(hook.error ? AllureStatus.FAILED : AllureStatus.PASSED, hook.error)
            return
        }

        if (hook.error) {
            // add hook as test to suite for mocha all hooks, when it didn't start before
            if (disableMochaHooks && isMochaAllHooks(hook.title)) {
                this.onTestStart(hook)
            }

            this.onTestFail(hook)
            return
        }

        this.onTestPass()
    }

    addLabel({
        name,
        value
    }: AddLabelEventArgs) {
        if (!this.currentTest) {
            return
        }

        this.currentTest.addLabel(name, value)
    }

    addLink({
        name,
        url,
        type,
    }: AddLinkEventArgs) {
        if (!this.currentTest) {
            return
        }

        this.currentTest.addLink(url, name, type)
    }

    addAllureId({
        id,
    }: AddAllureIdEventArgs) {
        this.addLabel({
            name: LabelName.AS_ID,
            value: id,
        })
    }

    addStory({
        storyName
    }: AddStoryEventArgs) {
        this.addLabel({
            name: LabelName.STORY,
            value: storyName,
        })
    }

    addFeature({
        featureName
    }: AddFeatureEventArgs) {
        this.addLabel({
            name: LabelName.FEATURE,
            value: featureName,
        })
    }

    addSeverity({
        severity
    }: AddSeverityEventArgs) {
        this.addLabel({
            name: LabelName.SEVERITY,
            value: severity,
        })
    }

    addEpic({
        epicName,
    }: AddEpicEventArgs) {
        this.addLabel({
            name: LabelName.EPIC,
            value: epicName,
        })
    }

    addOwner({
        owner,
    }: AddOwnerEventArgs) {
        this.addLabel({
            name: LabelName.OWNER,
            value: owner,
        })
    }

    addSuite({
        suiteName,
    }: AddSuiteEventArgs) {
        this.addLabel({
            name: LabelName.SUITE,
            value: suiteName,
        })
    }

    addParentSuite({
        suiteName,
    }: AddParentSuiteEventArgs) {
        this.addLabel({
            name: LabelName.PARENT_SUITE,
            value: suiteName,
        })
    }

    addSubSuite({
        suiteName,
    }: AddSubSuiteEventArgs) {
        this.addLabel({
            name: LabelName.SUB_SUITE,
            value: suiteName,
        })
    }

    addTag({
        tag,
    }: AddTagEventArgs) {
        this.addLabel({
            name: LabelName.TAG,
            value: tag,
        })
    }

    addTestId({
        testId,
        linkName,
    }: AddTestIdEventArgs) {
        const tmsLink = getLinkByTemplate(this._options.tmsLinkTemplate, testId)

        this.addLink({
            url: tmsLink,
            name: linkName,
            type: LinkType.TMS
        })
    }

    addIssue({
        issue,
        linkName,
    }: AddIssueEventArgs) {
        const issueLink = getLinkByTemplate(this._options.issueLinkTemplate, issue)

        this.addLink({
            url: issueLink,
            name: linkName,
            type: LinkType.ISSUE
        })
    }

    addEnvironment({
        name,
        value
    }: AddEnvironmentEventArgs) {
        this._allure.writeEnvironmentInfo({
            [name]: value,
        })
    }

    addDescription({
        description,
        descriptionType
    }: AddDescriptionEventArgs) {
        if (!this.currentTest) {
            return
        }

        if (descriptionType === DescriptionType.HTML) {
            this.currentTest.descriptionHtml = description
            return
        }

        this.currentTest.description = description
    }

    addAttachment({
        name,
        content,
        type = ContentType.TEXT
    }: AddAttachmentEventArgs) {
        if (!this.currentTest) {
            return
        }

        if (type === ContentType.JSON) {
            this.attachJSON(name, content)
            return
        }

        this.attachFile(name, Buffer.from(content as string), type as ContentType)
    }

    startStep(title: string) {
        if (!this.currentAllureSpec) {
            return
        }

        this._startStep(title)
    }

    endStep(status: AllureStatus) {
        if (!this.currentAllureSpec) {
            return
        }

        this._endTest(status)
    }

    addStep({
        step
    }: any) {
        if (!this.currentAllureSpec) {
            return
        }

        this._startStep(step.title)

        if (step.attachment) {
            this.attachFile(step.attachment.name, step.attachment.content, step.attachment.type || ContentType.TEXT)
        }

        this._endTest(step.status)
    }

    addArgument({
        name,
        value
    }: any) {
        if (!this.currentTest) {
            return
        }

        this.currentTest.addParameter(name, value)
    }

    /**
     * public API attached to the reporter
     * deprecated approach and only here for backwards compatibility
     */
    // TODO: add attachment method
    static addFeature = addFeature
    static addLink = addLink
    static addEpic = addEpic
    static addOwner = addOwner
    static addTag = addTag
    static addLabel = addLabel
    static addSeverity = addSeverity
    static addIssue = addIssue
    static addSuite = addSuite
    static addSubSuite = addSubSuite
    static addParentSuite = addParentSuite
    static addTestId = addTestId
    static addStory = addStory
    static addEnvironment = addEnvironment
    static addDescription = addDescription
    static addAttachment = addAttachment
    static startStep = startStep
    static endStep = endStep
    static addStep = addStep
    static addArgument = addArgument
    static addAllureId = addAllureId
}
