import _ from 'lodash';
import path from 'path';
import B from 'bluebird';
import { BaseDriver, errors, isErrorType, DeviceSettings} from 'appium/driver';
import { EspressoRunner, TEST_APK_PKG } from './espresso-runner';
import { fs, tempDir, zip } from 'appium/support';
import commands from './commands';
import { DEFAULT_ADB_PORT } from 'appium-adb';
import { androidHelpers, androidCommands, SETTINGS_HELPER_PKG_ID, } from 'appium-android-driver';
import desiredCapConstraints from './desired-caps';
import { findAPortNotInUse } from 'portscanner';
import { retryInterval } from 'asyncbox';
import { qualifyActivityName, getPackageInfo } from './utils';
import { newMethodMap } from './method-map';


// TODO merge our own helpers onto this later
const helpers = androidHelpers;

// The range of ports we can use on the system for communicating to the
// Espresso HTTP server on the device
const SYSTEM_PORT_RANGE = [8300, 8399];

// This is the port that the espresso server listens to on the device. We will
// forward one of the ports above on the system to this port on the device.
const DEVICE_PORT = 6791;

// NO_PROXY contains the paths that we never want to proxy to espresso server.
// TODO:  Add the list of paths that we never want to proxy to espresso server.
// TODO: Need to segregate the paths better way using regular expressions wherever applicable.
// (Not segregating right away because more paths to be added in the NO_PROXY list)
const NO_PROXY = [
  ['GET', new RegExp('^/session/(?!.*/)')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/current_activity')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/current_package')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/display_density')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/is_keyboard_shown')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/system_bars')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/system_time')],
  ['GET', new RegExp('^/session/[^/]+/appium/settings')],
  ['GET', new RegExp('^/session/[^/]+/context')],
  ['GET', new RegExp('^/session/[^/]+/contexts')],
  ['GET', new RegExp('^/session/[^/]+/ime/[^/]+')],
  ['GET', new RegExp('^/session/[^/]+/network_connection')],
  ['GET', new RegExp('^/session/[^/]+/timeouts')],
  ['GET', new RegExp('^/session/[^/]+/url')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/background')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/close')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/launch')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/reset')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/strings')],
  ['POST', new RegExp('^/session/[^/]+/appium/compare_images')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/activate_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/app_installed')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/app_state')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/finger_print')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/get_clipboard')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/install_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/is_locked')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/lock')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/pull_file')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/pull_folder')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/push_file')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/remove_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/start_activity')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/terminate_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/unlock')],
  ['POST', new RegExp('^/session/[^/]+/appium/getPerformanceData')],
  ['POST', new RegExp('^/session/[^/]+/appium/performanceData/types')],
  ['POST', new RegExp('^/session/[^/]+/appium/settings')],
  ['POST', new RegExp('^/session/[^/]+/appium/execute_driver')],
  ['POST', new RegExp('^/session/[^/]+/appium/start_recording_screen')],
  ['POST', new RegExp('^/session/[^/]+/appium/stop_recording_screen')],
  ['POST', new RegExp('^/session/[^/]+/context')],
  ['POST', new RegExp('^/session/[^/]+/execute')],
  ['POST', new RegExp('^/session/[^/]+/execute/async')],
  ['POST', new RegExp('^/session/[^/]+/execute/sync')],
  ['POST', new RegExp('^/session/[^/]+/execute_async')],
  ['POST', new RegExp('^/session/[^/]+/ime/[^/]+')],
  ['POST', new RegExp('^/session/[^/]+/location')],
  ['POST', new RegExp('^/session/[^/]+/network_connection')],
  ['POST', new RegExp('^/session/[^/]+/timeouts')],
  ['POST', new RegExp('^/session/[^/]+/url')],

  // MJSONWP commands
  ['GET', new RegExp('^/session/[^/]+/log/types')],
  ['POST', new RegExp('^/session/[^/]+/log')],

  // W3C commands
  // For Selenium v4 (W3C does not have this route)
  ['GET', new RegExp('^/session/[^/]+/se/log/types')],
  // For Selenium v4 (W3C does not have this route)
  ['POST', new RegExp('^/session/[^/]+/se/log')],
];

// This is a set of methods and paths that we never want to proxy to Chromedriver.
const CHROME_NO_PROXY = [
  ['GET', new RegExp('^/session/[^/]+/appium')],
  ['GET', new RegExp('^/session/[^/]+/context')],
  ['GET', new RegExp('^/session/[^/]+/element/[^/]+/rect')],
  ['GET', new RegExp('^/session/[^/]+/orientation')],
  ['POST', new RegExp('^/session/[^/]+/appium')],
  ['POST', new RegExp('^/session/[^/]+/context')],
  ['POST', new RegExp('^/session/[^/]+/orientation')],
  ['POST', new RegExp('^/session/[^/]+/touch/multi/perform')],
  ['POST', new RegExp('^/session/[^/]+/touch/perform')],

  // this is needed to make the mobile: commands working in web context
  ['POST', new RegExp('^/session/[^/]+/execute$')],
  ['POST', new RegExp('^/session/[^/]+/execute/sync')],

  // MJSONWP commands
  ['GET', new RegExp('^/session/[^/]+/log/types')],
  ['POST', new RegExp('^/session/[^/]+/log')],

  // W3C commands
  // For Selenium v4 (W3C does not have this route)
  ['GET', new RegExp('^/session/[^/]+/se/log/types')],
  // For Selenium v4 (W3C does not have this route)
  ['POST', new RegExp('^/session/[^/]+/se/log')],
];


const APK_EXT = '.apk';
const AAB_EXT = '.aab';
const SUPPORTED_EXTENSIONS = [APK_EXT, AAB_EXT];

class EspressoDriver extends BaseDriver {

  static newMethodMap = newMethodMap;

  constructor (opts = {}, shouldValidateCaps = true) {
    // `shell` overwrites adb.shell, so remove
    delete opts.shell;

    super(opts, shouldValidateCaps);
    this.locatorStrategies = [
      'id',
      'class name',
      'accessibility id',
    ];
    this.desiredCapConstraints = desiredCapConstraints;
    this.espresso = null;
    this.jwpProxyActive = false;
    this.defaultIME = null;
    this.jwpProxyAvoid = NO_PROXY;

    this.apkStrings = {}; // map of language -> strings obj
    this.settings = new DeviceSettings({}, this.onSettingsUpdate.bind(this));

    this.chromedriver = null;
    this.sessionChromedrivers = {};
  }

  async createSession (...args) {
    try {
      // TODO handle otherSessionData for multiple sessions
      let [sessionId, caps] = await super.createSession(...args);

      let serverDetails = {
        platform: 'LINUX',
        webStorageEnabled: false,
        takesScreenshot: true,
        javascriptEnabled: true,
        databaseEnabled: false,
        networkConnectionEnabled: true,
        locationContextEnabled: false,
        warnings: {},
        desired: Object.assign({}, this.caps)
      };

      this.caps = Object.assign(serverDetails, this.caps);

      this.curContext = this.defaultContextName();

      let defaultOpts = {
        fullReset: false,
        autoLaunch: true,
        adbPort: DEFAULT_ADB_PORT,
        androidInstallTimeout: 90000
      };
      _.defaults(this.opts, defaultOpts);

      if (this.isChromeSession) {
        if (this.opts.app) {
          this.log.warn(`'browserName' capability will be ignored`);
          this.log.warn(`Chrome browser cannot be run in Espresso sessions because Espresso automation doesn't ` +
              `have permission to access Chrome`);
        } else {
          this.log.errorAndThrow(`Chrome browser sessions cannot be run in Espresso because Espresso ` +
            `automation doesn't have permission to access Chrome`);
        }
      }

      if (this.opts.reboot) {
        this.setAvdFromCapabilities(caps);
        this.addWipeDataToAvdArgs();
      }

      this.opts.systemPort = this.opts.systemPort
        || await findAPortNotInUse(SYSTEM_PORT_RANGE[0], SYSTEM_PORT_RANGE[1]);
      this.opts.adbPort = this.opts.adbPort || DEFAULT_ADB_PORT;
      // get device udid for this session
      const {udid, emPort} = await helpers.getDeviceInfoFromCaps(this.opts);
      this.opts.udid = udid;
      this.opts.emPort = emPort;
      // now that we know our java version and device info, we can create our
      // ADB instance
      this.adb = await androidHelpers.createADB(this.opts);

      if (this.opts.app) {
        // find and copy, or download and unzip an app url or path
        this.opts.app = await this.helpers.configureApp(this.opts.app, {
          onPostProcess: this.onPostConfigureApp.bind(this),
          supportedExtensions: SUPPORTED_EXTENSIONS
        });
      } else if (this.appOnDevice) {
        // the app isn't an actual app file but rather something we want to
        // assume is on the device and just launch via the appPackage
        this.log.info(`App file was not listed, instead we're going to run ` +
            `${this.opts.appPackage} directly on the device`);
        if (!await this.adb.isAppInstalled(this.opts.appPackage)) {
          this.log.errorAndThrow(`Could not find the package '${this.opts.appPackage}' ` +
            `installed on the device`);
        }
      }

      await this.startEspressoSession();
      return [sessionId, caps];
    } catch (e) {
      await this.deleteSession();
      e.message += `${_.endsWith(e.message, '.') ? '' : '.'} Check ` +
        'https://github.com/appium/appium-espresso-driver#troubleshooting ' +
        'regarding advanced session startup troubleshooting.';
      if (isErrorType(e, errors.SessionNotCreatedError)) {
        throw e;
      }
      const err = new errors.SessionNotCreatedError(e.message);
      err.stack = e.stack;
      throw err;
    }
  }

  /**
   * Unzip the given app path and return the first package that has SUPPORTED_EXTENSIONS
   * in the archived file.
   *
   * @param {string} appPath The path to app file.
   * @returns {string} Retuns the path to an unzipped app file path.
   * @throws Raise an exception if the zip did not have any SUPPORTED_EXTENSIONS packages.
   */
  async unzipApp (appPath) {
    const useSystemUnzipEnv = process.env.APPIUM_PREFER_SYSTEM_UNZIP;
    const useSystemUnzip = _.isEmpty(useSystemUnzipEnv)
      || !['0', 'false'].includes(_.toLower(useSystemUnzipEnv));
    const tmpRoot = await tempDir.openDir();
    await zip.extractAllTo(appPath, tmpRoot, {useSystemUnzip});

    const globPattern = `**/*.+(${SUPPORTED_EXTENSIONS.map((ext) => ext.replace(/^\./, '')).join('|')})`;
    const sortedBundleItems = (await fs.glob(globPattern, {
      cwd: tmpRoot,
      strict: false,
    })).sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    if (sortedBundleItems.length === 0) {
      // no expected packages in the zip
      this.log.errorAndThrow(`${this.opts.app} did not have any of '${SUPPORTED_EXTENSIONS.join(', ')}' ` +
        `extension packages. Please make sure the provided .zip archive contains at least one valid application package.`);
    }
    const unzippedAppPath = path.join(tmpRoot, _.first(sortedBundleItems));
    this.log.debug(`'${unzippedAppPath}' is the unzipped file from '${appPath}'`);
    return unzippedAppPath;
  }

  async onPostConfigureApp ({cachedAppInfo, isUrl, appPath}) {
    const presignApp = async (appLocation) => {
      if (this.opts.noSign) {
        this.log.info('Skipping application signing because noSign capability is set to true. ' +
          'Having the application under test with improper signature/non-signed will cause ' +
          'Espresso automation startup failure.');
      } else if (!await this.adb.checkApkCert(appLocation, this.opts.appPackage)) {
        await this.adb.sign(appLocation, this.opts.appPackage);
      }
    };

    const hasApkExt = (appPath) => _.endsWith(_.toLower(appPath), APK_EXT);
    const hasAabExt = (appPath) => _.endsWith(_.toLower(appPath), AAB_EXT);
    const extractUniversalApk = async (shouldExtract, appPath) =>
      shouldExtract ? appPath : await this.adb.extractUniversalApk(appPath);

    let pathInCache = null;
    let isResultAppPathAlreadyCached = false;
    if (_.isPlainObject(cachedAppInfo)) {
      const packageHash = await fs.hash(appPath);
      if (packageHash === cachedAppInfo.packageHash && await fs.exists(cachedAppInfo.fullPath)) {
        this.log.info(`Using '${cachedAppInfo.fullPath}' which is cached from '${appPath}'`);
        isResultAppPathAlreadyCached = true;
        pathInCache = cachedAppInfo.fullPath;
      }
    }

    // appPath can be .zip, .apk or .aab
    const isApk = hasApkExt(appPath);
    // Only local .apk files that are available in-place should not be cached
    const shouldResultAppPathBeCached = !isApk || (isApk && isUrl);

    if (!isResultAppPathAlreadyCached) {
      if (shouldResultAppPathBeCached) {
        // .zip, .aab or downloaded .apk

        let unzippedAppPath;
        let isUnzippedApk = false;
        if (!(hasApkExt(appPath) || hasAabExt(appPath))) {
          unzippedAppPath = await this.unzipApp(appPath);
          isUnzippedApk = hasApkExt(unzippedAppPath);
        }

        // unzippedAppPath or appPath has SUPPORTED_EXTENSIONS.
        pathInCache = unzippedAppPath
          ? await extractUniversalApk(isUnzippedApk, unzippedAppPath)
          : await extractUniversalApk(isApk, appPath);

        if (!isApk && isUrl) {
          // Clean up the temporarily downloaded .aab or .zip package
          await fs.rimraf(appPath);
        }
        if (hasAabExt(unzippedAppPath)) {
          // Cleanup the local unzipped .aab file
          await fs.rimraf(unzippedAppPath);
        }
        await presignApp(pathInCache);
      } else if (isApk) {
        // It is probably not the best idea to modify the provided app in-place,
        // but this is how it was always working
        await presignApp(appPath);
      }
    }
    return shouldResultAppPathBeCached ? {appPath: pathInCache} : false;
  }

  get driverData () {
    // TODO fille out resource info here
    return {};
  }

  isEmulator () {
    return helpers.isEmulator(this.adb, this.opts);
  }

  // TODO this method is duplicated from uiautomator2-driver; consolidate
  setAvdFromCapabilities (caps) {
    if (this.opts.avd) {
      this.log.info('avd name defined, ignoring device name and platform version');
    } else {
      if (!caps.deviceName) {
        this.log.errorAndThrow('avd or deviceName should be specified when reboot option is enables');
      }
      if (!caps.platformVersion) {
        this.log.errorAndThrow('avd or platformVersion should be specified when reboot option is enabled');
      }
      let avdDevice = caps.deviceName.replace(/[^a-zA-Z0-9_.]/g, '-');
      this.opts.avd = `${avdDevice}__${caps.platformVersion}`;
    }
  }

  // TODO this method is duplicated from uiautomator2-driver; consolidate
  addWipeDataToAvdArgs () {
    if (!this.opts.avdArgs) {
      this.opts.avdArgs = '-wipe-data';
    } else if (!this.opts.avdArgs.toLowerCase().includes('-wipe-data')) {
      this.opts.avdArgs += ' -wipe-data';
    }
  }

  // TODO much of this logic is duplicated from uiautomator2
  async startEspressoSession () {
    const {manifestPayload} = await getPackageInfo();
    this.log.info(`EspressoDriver version: ${manifestPayload.version}`);

    // Read https://github.com/appium/appium-android-driver/pull/461 what happens if ther is no setHiddenApiPolicy for Android P+
    if (await this.adb.getApiLevel() >= 28) { // Android P
      this.log.warn('Relaxing hidden api policy');
      await this.adb.setHiddenApiPolicy('1', !!this.opts.ignoreHiddenApiPolicyError);
    }

    // get appPackage et al from manifest if necessary
    let appInfo = await helpers.getLaunchInfo(this.adb, this.opts);
    if (appInfo) {
      // and get it onto our 'opts' object so we use it from now on
      Object.assign(this.opts, appInfo);
    } else {
      appInfo = this.opts;
    }

    // start an avd, set the language/locale, pick an emulator, etc...
    // TODO with multiple devices we'll need to parameterize this
    await helpers.initDevice(this.adb, this.opts);
    // https://github.com/appium/appium-espresso-driver/issues/72
    if (await this.adb.isAnimationOn()) {
      try {
        await this.adb.setAnimationState(false);
        this.wasAnimationEnabled = true;
      } catch (err) {
        this.log.warn(`Unable to turn off animations: ${err.message}`);
      }
    }

    // set actual device name, udid
    this.caps.deviceName = this.adb.curDeviceId;
    this.caps.deviceUDID = this.opts.udid;

    // set up the modified espresso server etc
    this.initEspressoServer();
    // Further prepare the device by forwarding the espresso port
    this.log.debug(`Forwarding Espresso Server port ${DEVICE_PORT} to ${this.opts.systemPort}`);
    await this.adb.forwardPort(this.opts.systemPort, DEVICE_PORT);

    if (!this.opts.skipUnlock) {
      // unlock the device to prepare it for testing
      await helpers.unlock(this, this.adb, this.caps);
    } else {
      this.log.debug(`'skipUnlock' capability set, so skipping device unlock`);
    }

    // set up app under test
    // prepare our actual AUT, get it on the device, etc...
    await this.initAUT();

    //Adding AUT package name in the capabilities if package name not exist in caps
    if (!this.caps.appPackage) {
      this.caps.appPackage = appInfo.appPackage;
    }
    if (!this.caps.appWaitPackage) {
      this.caps.appWaitPackage = appInfo.appWaitPackage || appInfo.appPackage || this.caps.appPackage;
    }
    if (this.caps.appActivity) {
      this.caps.appActivity = qualifyActivityName(this.caps.appActivity, this.caps.appPackage);
    } else {
      this.caps.appActivity = qualifyActivityName(appInfo.appActivity, this.caps.appPackage);
    }
    if (this.caps.appWaitActivity) {
      this.caps.appWaitActivity = qualifyActivityName(this.caps.appWaitActivity, this.caps.appWaitPackage);
    } else {
      this.caps.appWaitActivity = qualifyActivityName(appInfo.appWaitActivity || appInfo.appActivity || this.caps.appActivity,
        this.caps.appWaitPackage);
    }

    // launch espresso and wait till its online and we have a session
    await this.espresso.startSession(this.caps);
    if (this.caps.autoLaunch === false) {
      this.log.info(`Not waiting for the application activity to start because 'autoLaunch' is disabled`);
    } else {
      await this.adb.waitForActivity(this.caps.appWaitPackage, this.caps.appWaitActivity, this.opts.appWaitDuration);
    }
    // if we want to immediately get into a webview, set our context
    // appropriately
    if (this.opts.autoWebview) {
      await this.initWebview();
    }

    // now that everything has started successfully, turn on proxying so all
    // subsequent session requests go straight to/from espresso
    this.jwpProxyActive = true;

    await this.addDeviceInfoToCaps();
  }

  async initWebview () {
    const viewName = androidCommands.defaultWebviewName.call(this);
    const timeout = this.opts.autoWebviewTimeout || 2000;
    this.log.info(`Setting webview to context '${viewName}' with timeout ${timeout}ms`);
    await retryInterval(timeout / 500, 500, this.setContext.bind(this), viewName);
  }

  async addDeviceInfoToCaps () {
    const {
      apiVersion,
      platformVersion,
      manufacturer,
      model,
      realDisplaySize,
      displayDensity,
    } = await this.mobileGetDeviceInfo();
    this.caps.deviceApiLevel = parseInt(apiVersion, 10);
    this.caps.platformVersion = platformVersion;
    this.caps.deviceScreenSize = realDisplaySize;
    this.caps.deviceScreenDensity = displayDensity;
    this.caps.deviceModel = model;
    this.caps.deviceManufacturer = manufacturer;
  }

  initEspressoServer () {
    // now that we have package and activity, we can create an instance of
    // espresso with the appropriate data
    this.espresso = new EspressoRunner(this.log, {
      host: this.opts.remoteAdbHost || this.opts.host || '127.0.0.1',
      systemPort: this.opts.systemPort,
      devicePort: DEVICE_PORT,
      adb: this.adb,
      apk: this.opts.app,
      tmpDir: this.opts.tmpDir,
      appPackage: this.opts.appPackage,
      appActivity: this.opts.appActivity,
      forceEspressoRebuild: !!this.opts.forceEspressoRebuild,
      espressoBuildConfig: this.opts.espressoBuildConfig,
      showGradleLog: !!this.opts.showGradleLog,
      serverLaunchTimeout: this.opts.espressoServerLaunchTimeout,
      androidInstallTimeout: this.opts.androidInstallTimeout,
      skipServerInstallation: this.opts.skipServerInstallation,
      useKeystore: this.opts.useKeystore,
      keystorePath: this.opts.keystorePath,
      keystorePassword: this.opts.keystorePassword,
      keyAlias: this.opts.keyAlias,
      keyPassword: this.opts.keyPassword,
      disableSuppressAccessibilityService: this.opts.disableSuppressAccessibilityService,
    });
    this.proxyReqRes = this.espresso.proxyReqRes.bind(this.espresso);
    this.proxyCommand = this.espresso.proxyCommand.bind(this.espresso);
  }

  // TODO this method is mostly duplicated from uiautomator2
  async initAUT () {
    // set the localized strings for the current language from the apk
    // TODO: incorporate changes from appium#5308 which fix a race cond-
    // ition bug in old appium and need to be replicated here
    // this.apkStrings[this.opts.language] = await androidHelpers.pushStrings(
    //     this.opts.language, this.adb, this.opts);

    // Uninstall any uninstallOtherPackages which were specified in caps
    if (this.opts.uninstallOtherPackages) {
      await helpers.uninstallOtherPackages(
        this.adb,
        helpers.parseArray(this.opts.uninstallOtherPackages),
        [SETTINGS_HELPER_PKG_ID, TEST_APK_PKG]
      );
    }

    if (!this.opts.app) {
      if (this.opts.fullReset) {
        this.log.errorAndThrow('Full reset requires an app capability, use fastReset if app is not provided');
      }
      this.log.debug('No app capability. Assuming it is already on the device');
      if (this.opts.fastReset) {
        await helpers.resetApp(this.adb, this.opts);
      }
    }

    if (!this.opts.skipUninstall) {
      await this.adb.uninstallApk(this.opts.appPackage);
    }
    if (this.opts.app) {
      await helpers.installApk(this.adb, this.opts);
    }
    if (this.opts.skipServerInstallation) {
      this.log.debug('skipServerInstallation capability is set. Not installig espresso-server ');
    } else {
      await this.espresso.installTestApk();
      try {
        await this.adb.addToDeviceIdleWhitelist(SETTINGS_HELPER_PKG_ID, TEST_APK_PKG);
      } catch (e) {
        this.log.warn(`Cannot add server packages to the Doze whitelist. Original error: ` +
          (e.stderr || e.message));
      }
    }
  }

  async deleteSession () {
    this.log.debug('Deleting espresso session');

    const screenRecordingStopTasks = [async () => {
      if (!_.isEmpty(this._screenRecordingProperties)) {
        await this.stopRecordingScreen();
      }
    }, async () => {
      if (await this.mobileIsMediaProjectionRecordingRunning()) {
        await this.mobileStopMediaProjectionRecording();
      }
    }, async () => {
      if (!_.isEmpty(this._screenStreamingProps)) {
        await this.mobileStopScreenStreaming();
      }
    }];

    await androidHelpers.removeAllSessionWebSocketHandlers(this.server, this.sessionId);

    if (this.espresso) {
      if (this.jwpProxyActive) {
        await this.espresso.deleteSession();
      }
      this.espresso = null;
    }
    this.jwpProxyActive = false;

    if (this.adb) {
      await B.all(screenRecordingStopTasks.map((task) => {
        (async () => {
          try {
            await task();
          } catch (ign) {}
        })();
      }));
      if (this.wasAnimationEnabled) {
        try {
          await this.adb.setAnimationState(true);
        } catch (err) {
          this.log.warn(`Unable to reset animation: ${err.message}`);
        }
      }
      if (this.opts.unicodeKeyboard && this.opts.resetKeyboard &&
          this.defaultIME) {
        this.log.debug(`Resetting IME to '${this.defaultIME}'`);
        await this.adb.setIME(this.defaultIME);
      }
      if (!this.isChromeSession && this.opts.appPackage && !this.opts.dontStopAppOnReset) {
        await this.adb.forceStop(this.opts.appPackage);
      }
      if (this.opts.fullReset && !this.opts.skipUninstall && !this.appOnDevice) {
        this.log.debug(`FULL_RESET set to 'true', Uninstalling '${this.opts.appPackage}'`);
        await this.adb.uninstallApk(this.opts.appPackage);
      }
      await this.adb.stopLogcat();
      if (this.opts.reboot) {
        let avdName = this.opts.avd.replace('@', '');
        this.log.debug(`closing emulator '${avdName}'`);
        await this.adb.killEmulator(avdName);
      }
      if (await this.adb.getApiLevel() >= 28) { // Android P
        this.log.info('Restoring hidden api policy to the device default configuration');
        await this.adb.setDefaultHiddenApiPolicy(!!this.opts.ignoreHiddenApiPolicyError);
      }
    }
    await super.deleteSession();
    if (this.opts.systemPort !== undefined) {
      try {
        await this.adb.removePortForward(this.opts.systemPort);
      } catch (error) {
        this.log.warn(`Unable to remove port forward '${error.message}'`);
        //Ignore, this block will also be called when we fall in catch block
        // and before even port forward.
      }
    }
  }

  async onSettingsUpdate () {
    // intentionally do nothing here, since commands.updateSettings proxies
    // settings to the espresso server already
  }

  proxyActive (sessionId) {
    super.proxyActive(sessionId);

    // we always have an active proxy to the espresso server
    return true;
  }

  canProxy (sessionId) {
    super.canProxy(sessionId);

    // we can always proxy to the espresso server
    return true;
  }

  getProxyAvoidList (sessionId) {
    super.getProxyAvoidList(sessionId);
    // we are maintaining two sets of NO_PROXY lists, one for chromedriver(CHROME_NO_PROXY)
    // and one for Espresso(NO_PROXY), based on current context will return related NO_PROXY list
    this.jwpProxyAvoid = _.isNil(this.chromedriver) ? NO_PROXY : CHROME_NO_PROXY;
    if (this.opts.nativeWebScreenshot) {
      this.jwpProxyAvoid = [...this.jwpProxyAvoid, ['GET', new RegExp('^/session/[^/]+/screenshot')]];
    }

    return this.jwpProxyAvoid;
  }

  get isChromeSession () {
    return helpers.isChromeBrowser(this.opts.browserName);
  }

  get appOnDevice () {
    return !this.opts.app && this.helpers.isPackageOrBundle(this.opts.appPackage);
  }
}

// first add the android-driver commands which we will fall back to
for (let [cmd, fn] of _.toPairs(androidCommands)) {
  // we do some different/special things with these methods
  if (!_.includes(['defaultWebviewName'], cmd)) {
    EspressoDriver.prototype[cmd] = fn;
  }
}

// then overwrite with any espresso-specific commands
for (let [cmd, fn] of _.toPairs(commands)) {
  EspressoDriver.prototype[cmd] = fn;
}

export { EspressoDriver };
export default EspressoDriver;
