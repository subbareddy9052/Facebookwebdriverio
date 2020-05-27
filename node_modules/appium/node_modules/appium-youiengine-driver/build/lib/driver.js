"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.YouiEngineDriver = void 0;

require("source-map-support/register");

var _appiumBaseDriver = require("appium-base-driver");

var _desiredCaps = require("./desired-caps");

var _logger = _interopRequireDefault(require("./logger"));

var _commands = _interopRequireDefault(require("./commands"));

var _lodash = _interopRequireDefault(require("lodash"));

var _bluebird = _interopRequireDefault(require("bluebird"));

var _asyncbox = require("asyncbox");

var _appiumAndroidDriver = _interopRequireDefault(require("appium-android-driver"));

var _appiumIosDriver = _interopRequireDefault(require("appium-ios-driver"));

var _appiumXcuitestDriver = _interopRequireDefault(require("appium-xcuitest-driver"));

var _appiumMacDriver = _interopRequireDefault(require("appium-mac-driver"));

var _bluesky = _interopRequireDefault(require("./bluesky"));

var _tvos = _interopRequireDefault(require("./tvos"));

var _tvossimulator = _interopRequireDefault(require("./tvossimulator"));

var _yimac = _interopRequireDefault(require("./yimac"));

const TO_PROXY_COMMON = ['background', 'closeApp', 'getLog', 'getLogTypes', 'getOrientation', 'getStrings', 'installApp', 'launchApp', 'lock', 'removeApp', 'setOrientation'];
const TO_PROXY_IOS_ONLY = ['mobileShake'];
const TO_PROXY_ANDROID_ONLY = ['getNetworkConnection', 'isAppInstalled', 'isLocked', 'longPressKeyCode', 'pressKeyCode', 'setNetworkConnection', 'toggleLocationServices', 'unlock'];
const TO_PROXY_IOS = TO_PROXY_IOS_ONLY.concat(TO_PROXY_COMMON);
const TO_PROXY_ANDROID = TO_PROXY_ANDROID_ONLY.concat(TO_PROXY_COMMON);
const TO_PROXY_MAC = TO_PROXY_COMMON;
const MAX_RETRY_COUNT = 3;
const SOCKET_TIMEOUT = 10000;

class YouiEngineDriver extends _appiumBaseDriver.BaseDriver {
  resetYouiEngine() {
    this.ready = false;
    this.socket = null;
    this.locatorStrategies = ['id', 'name', 'class name', 'accessibility id'];
    this.proxydriver = null;
    this.proxyAllowList = '';
    this.device = null;
  }

  constructor(opts, shouldValidateCaps) {
    super(opts, shouldValidateCaps);
    this.desiredCapConstraints = _desiredCaps.desiredCapConstraints;
    this.settings = new _appiumBaseDriver.DeviceSettings({
      'TimeDilation': 1,
      'SourceTreeFilter': ''
    }, this.onSettingsUpdate.bind(this));
    this.resetYouiEngine();
  }

  validateLocatorStrategy(strategy) {
    super.validateLocatorStrategy(strategy, false);
  }

  async createSession(caps) {
    try {
      let [sessionId] = await super.createSession(caps);

      if (caps.platformName !== null) {
        let appPlatform = caps.platformName.toLowerCase();

        switch (appPlatform) {
          case 'ios':
            await this.startIOSSession(caps);
            break;

          case 'android':
            await this.startAndroidSession(caps);
            break;

          case 'mac':
            await this.startMacSession(caps);
            break;

          case 'yimac':
            this.device = new _yimac.default();
            await this.device.startSession(caps);
            break;

          case 'bluesky':
            this.device = new _bluesky.default();
            await this.device.startSession(caps);
            break;

          case 'yitvos':
            {
              let shell = require('shelljs');

              if (shell.exec(`instruments -s devices | grep '${caps.udid}'`).includes('(Simulator)')) {
                this.device = new _tvossimulator.default();
              } else {
                this.device = new _tvos.default();
              }

              await this.device.startSession(caps, this);
              break;
            }

          case 'noproxy':
          case 'connecttoapp':
            break;

          default:
            _logger.default.errorAndThrow(`Unsupported platformName: ${caps.platformName}`);

        }
      }

      await this.connectSocket();

      if (caps.fullSourceTree === true) {} else {
        _logger.default.debug('Setting SourceTreeFilter to displayed elements only');

        await this.updateSettings({
          SourceTreeFilter: "[@isDisplayed='true']"
        });
      }

      return [sessionId, this.opts];
    } catch (e) {
      await this.deleteSession();
      throw e;
    }
  }

  async onSettingsUpdate(key, value) {
    if (key === 'TimeDilation') {
      await this.setTimeDilation(value);
    } else if (key === 'SourceTreeFilter') {
      await this.setSourceTreeFilter(value);
    }
  }

  async stop() {
    this.ready = false;
  }

  async deleteSession() {
    _logger.default.debug('Deleting YouiEngine session');

    if (this.caps.platformName !== null) {
      let appPlatform = this.caps.platformName.toLowerCase();

      if (['yimac', 'yitvos', 'bluesky'].includes(appPlatform)) {
        if (this.device) {
          this.device.endSession();
        }
      }
    }

    if (this.proxydriver !== null) {
      await this.proxydriver.deleteSession();
    }

    this.socket.end();
    this.socket.destroy();
    await super.deleteSession();
    await this.stop();
  }

  driverShouldDoProxyCmd(command) {
    if (!this.proxydriver) {
      return false;
    }

    for (let allowedCommand of this.proxyAllowList) {
      if (allowedCommand === command) {
        return true;
      }
    }

    return false;
  }

  async executeCommand(cmd, ...args) {
    if (cmd === 'receiveAsyncResponse') {
      _logger.default.debug(`Executing YouiEngineDriver response '${cmd}'`);

      return await this.receiveAsyncResponse(...args);
    } else if (this.ready) {
      if (this.driverShouldDoProxyCmd(cmd)) {
        _logger.default.debug(`Executing proxied WebDriver command '${cmd}'`);

        this.clearNewCommandTimeout();
        let result = this.proxydriver.executeCommand(cmd, ...args);
        this.startNewCommandTimeout(cmd);
        return result;
      } else {
        _logger.default.debug(`Executing YouiEngine WebDriver command '${cmd}'`);

        return await super.executeCommand(cmd, ...args);
      }
    } else {
      _logger.default.debug(`Command Error '${cmd}'`);

      throw new _appiumBaseDriver.errors.NoSuchDriverError(`Driver is not ready, cannot execute ${cmd}.`);
    }
  }

  validateDesiredCaps(caps) {
    let res = super.validateDesiredCaps(caps);

    if (!res) {
      return res;
    }

    if (!caps.youiEngineAppAddress) {
      let msg = 'The desired capabilities must include youiEngineAppAddress';

      _logger.default.errorAndThrow(msg);
    }

    if (caps.platformName.toLowerCase() !== 'connecttoapp' && caps.platformName.toLowerCase() !== 'noproxy') {
      if (!caps.app) {
        let msg = 'The desired capabilities must include app';

        _logger.default.errorAndThrow(msg);
      }

      const fs = require('fs');

      const path = require('path');

      if (!fs.existsSync(caps.app)) {
        let absolutepath = path.resolve(caps.app);
        let msg = 'The app could not be found in following location: ' + absolutepath;

        _logger.default.errorAndThrow(msg);
      }

      if (caps.deviceName.toLowerCase() === 'android') {
        if (!caps.avd) {
          let msg = 'The desired capabilities must include avd';

          _logger.default.errorAndThrow(msg);
        }
      }
    }

    return true;
  }

  async setupNewIOSDriver(caps) {
    let iosArgs = {
      javascriptEnabled: true
    };
    let iosdriver = new _appiumXcuitestDriver.default(iosArgs);

    if (caps.platformVersion) {
      let majorVer = caps.platformVersion.toString().split('.')[0];

      if (parseInt(majorVer, 10) < 10) {
        iosdriver = new _appiumIosDriver.default(iosArgs);
      }
    }

    let capsCopy = _lodash.default.cloneDeep(caps);

    capsCopy.newCommandTimeout = 0;
    await iosdriver.createSession(capsCopy);
    return iosdriver;
  }

  async startIOSSession(caps) {
    _logger.default.info('Starting an IOS proxy session');

    this.proxyAllowList = TO_PROXY_IOS;
    this.proxydriver = await this.setupNewIOSDriver(caps);
  }

  async setupNewAndroidDriver(caps) {
    let androidArgs = {
      javascriptEnabled: true
    };
    let androiddriver = new _appiumAndroidDriver.default(androidArgs);

    let capsCopy = _lodash.default.cloneDeep(caps);

    capsCopy.newCommandTimeout = 0;
    await androiddriver.createSession(capsCopy);
    return androiddriver;
  }

  async startAndroidSession(caps) {
    _logger.default.info('Starting an Android proxy session');

    this.proxyAllowList = TO_PROXY_ANDROID;
    this.proxydriver = await this.setupNewAndroidDriver(caps);
  }

  async setupNewMacDriver(caps) {
    let macArgs = {
      javascriptEnabled: true
    };
    let macdriver = new _appiumMacDriver.default(macArgs);

    let capsCopy = _lodash.default.cloneDeep(caps);

    capsCopy.newCommandTimeout = 0;
    await macdriver.createSession(capsCopy);
    return macdriver;
  }

  async startMacSession(caps) {
    _logger.default.info('Starting a Mac proxy session');

    this.proxyAllowList = TO_PROXY_MAC;
    this.proxydriver = await this.setupNewMacDriver(caps);
  }

  async connectSocket() {
    let retryCount = 0;
    let connected = false;
    let errno = 'EOK';

    while (retryCount < MAX_RETRY_COUNT && !connected) {
      _logger.default.info('Attempt #' + (retryCount + 1));

      let connectedPromise = new _bluebird.default(resolve => {
        let net = require('net');

        let HOST = this.opts.youiEngineAppAddress;
        let PORT;

        if (this.caps.youiEngineAppPort) {
          PORT = this.caps.youiEngineAppPort;
        } else if (this.caps.platformName.toLowerCase() === 'yips4') {
          PORT = 40123;
        } else {
          PORT = 12345;
        }

        {
          _logger.default.info('Connecting to WebDriver: ' + HOST + ':' + PORT);
        }
        this.socket = new net.Socket();
        this.socket.setTimeout(SOCKET_TIMEOUT);
        this.socket.setKeepAlive(true, 1000);
        let socketClient = this.socket;

        let removeListenerHandler = function () {
          socketClient.removeListener('timeout', timeoutHandler);
          socketClient.removeListener('close', closeHandler);
          socketClient.removeListener('end', endHandler);
          socketClient.removeListener('error', errorHandler);
        };

        let errorHandler = function (ex) {
          _logger.default.error(ex);

          _logger.default.error('Check that WebDriver is enabled in application, if a device ensure the proper IP address is used.');

          removeListenerHandler();
          socketClient.destroy();
          errno = ex.errno;
          resolve(false);
        };

        this.socket.on('error', errorHandler);

        let closeHandler = function () {
          _logger.default.info('Connection closed');

          removeListenerHandler();
          socketClient.destroy();
          resolve(false);
        };

        this.socket.on('close', closeHandler);

        let timeoutHandler = function () {
          _logger.default.error('Connection timed out');

          removeListenerHandler();
          socketClient.destroy();
          resolve(false);
        };

        this.socket.on('timeout', timeoutHandler);
        this.socket.connect(PORT, HOST, function () {
          _logger.default.error('Connection established');

          removeListenerHandler();
          resolve(true);
        });

        let endHandler = function () {
          _logger.default.info('Connection ended');

          removeListenerHandler();
          socketClient.destroy();
          resolve(false);
        };

        this.socket.on('end', endHandler);
      });
      retryCount++;
      connected = await connectedPromise;

      if (!connected && errno === 'ECONNREFUSED') {
        _logger.default.debug('Connection refused, sleeping...');

        await (0, _asyncbox.sleep)(2000);
        errno = 'EOK';
      }

      if (!connected && retryCount === MAX_RETRY_COUNT - 1) {
        _logger.default.errorAndThrow('Failed to connect ' + MAX_RETRY_COUNT + ' times. Aborting.');
      }
    }

    retryCount = 0;
    this.ready = connected;
  }

  async executeSocketCommand(cmd) {
    if (!this.socket.writable) {
      _logger.default.info('Socket is not writable. Trying to reconnect.');

      await this.connectSocket();
    }

    let retryCount = 0;

    while (retryCount < MAX_RETRY_COUNT) {
      this.socket.setTimeout(SOCKET_TIMEOUT);
      let cmdPromise = new _bluebird.default(resolve => {
        _logger.default.debug('COMMAND: ' + cmd);

        let totaldata = [];
        let endMarker = new Buffer.from('youiend');
        let socketClient = this.socket;

        let removeListenerHandler = function () {
          socketClient.removeListener('data', dataHandler);
          socketClient.removeListener('timeout', timeoutHandler);
          socketClient.removeListener('error', errorHandler);
        };

        let timeoutHandler = function () {
          _logger.default.info('Timeout in execute command.');

          removeListenerHandler();
          resolve(false);
        };

        let errorHandler = function () {
          _logger.default.info('On error');

          removeListenerHandler();
          resolve(false);
        };

        let dataHandler = function (data) {
          if (data.length >= endMarker.length) {
            let dataend = new Buffer.alloc(endMarker.length);
            let startIndex = data.length - endMarker.length;
            data.copy(dataend, 0, startIndex, startIndex + endMarker.length);

            if (dataend.equals(endMarker)) {
              let lastData = data.slice(0, startIndex);
              totaldata.push(lastData);
              removeListenerHandler();
              resolve(Buffer.concat(totaldata));
            } else {
              totaldata.push(data);
            }
          }
        };

        socketClient.write(cmd + '\n', 'UTF8', () => {
          socketClient.on('data', dataHandler);
          socketClient.on('timeout', timeoutHandler);
          socketClient.on('error', errorHandler);
        });
      });
      let res = await cmdPromise;

      if (res === false) {
        retryCount++;

        _logger.default.info('Socket failed. Retrying: ' + retryCount);

        continue;
      } else {
        return res;
      }
    }

    throw new Error('ExecuteSocketCommand failed.');
  }

}

exports.YouiEngineDriver = YouiEngineDriver;

for (let [cmd, fn] of _lodash.default.toPairs(_commands.default)) {
  YouiEngineDriver.prototype[cmd] = fn;
}require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImxpYi9kcml2ZXIuanMiXSwibmFtZXMiOlsiVE9fUFJPWFlfQ09NTU9OIiwiVE9fUFJPWFlfSU9TX09OTFkiLCJUT19QUk9YWV9BTkRST0lEX09OTFkiLCJUT19QUk9YWV9JT1MiLCJjb25jYXQiLCJUT19QUk9YWV9BTkRST0lEIiwiVE9fUFJPWFlfTUFDIiwiTUFYX1JFVFJZX0NPVU5UIiwiU09DS0VUX1RJTUVPVVQiLCJZb3VpRW5naW5lRHJpdmVyIiwiQmFzZURyaXZlciIsInJlc2V0WW91aUVuZ2luZSIsInJlYWR5Iiwic29ja2V0IiwibG9jYXRvclN0cmF0ZWdpZXMiLCJwcm94eWRyaXZlciIsInByb3h5QWxsb3dMaXN0IiwiZGV2aWNlIiwiY29uc3RydWN0b3IiLCJvcHRzIiwic2hvdWxkVmFsaWRhdGVDYXBzIiwiZGVzaXJlZENhcENvbnN0cmFpbnRzIiwic2V0dGluZ3MiLCJEZXZpY2VTZXR0aW5ncyIsIm9uU2V0dGluZ3NVcGRhdGUiLCJiaW5kIiwidmFsaWRhdGVMb2NhdG9yU3RyYXRlZ3kiLCJzdHJhdGVneSIsImNyZWF0ZVNlc3Npb24iLCJjYXBzIiwic2Vzc2lvbklkIiwicGxhdGZvcm1OYW1lIiwiYXBwUGxhdGZvcm0iLCJ0b0xvd2VyQ2FzZSIsInN0YXJ0SU9TU2Vzc2lvbiIsInN0YXJ0QW5kcm9pZFNlc3Npb24iLCJzdGFydE1hY1Nlc3Npb24iLCJZaU1hYyIsInN0YXJ0U2Vzc2lvbiIsIkJsdWVTa3kiLCJzaGVsbCIsInJlcXVpcmUiLCJleGVjIiwidWRpZCIsImluY2x1ZGVzIiwiVHZPc1NpbXVsYXRvciIsIlR2T3MiLCJsb2dnZXIiLCJlcnJvckFuZFRocm93IiwiY29ubmVjdFNvY2tldCIsImZ1bGxTb3VyY2VUcmVlIiwiZGVidWciLCJ1cGRhdGVTZXR0aW5ncyIsIlNvdXJjZVRyZWVGaWx0ZXIiLCJlIiwiZGVsZXRlU2Vzc2lvbiIsImtleSIsInZhbHVlIiwic2V0VGltZURpbGF0aW9uIiwic2V0U291cmNlVHJlZUZpbHRlciIsInN0b3AiLCJlbmRTZXNzaW9uIiwiZW5kIiwiZGVzdHJveSIsImRyaXZlclNob3VsZERvUHJveHlDbWQiLCJjb21tYW5kIiwiYWxsb3dlZENvbW1hbmQiLCJleGVjdXRlQ29tbWFuZCIsImNtZCIsImFyZ3MiLCJyZWNlaXZlQXN5bmNSZXNwb25zZSIsImNsZWFyTmV3Q29tbWFuZFRpbWVvdXQiLCJyZXN1bHQiLCJzdGFydE5ld0NvbW1hbmRUaW1lb3V0IiwiZXJyb3JzIiwiTm9TdWNoRHJpdmVyRXJyb3IiLCJ2YWxpZGF0ZURlc2lyZWRDYXBzIiwicmVzIiwieW91aUVuZ2luZUFwcEFkZHJlc3MiLCJtc2ciLCJhcHAiLCJmcyIsInBhdGgiLCJleGlzdHNTeW5jIiwiYWJzb2x1dGVwYXRoIiwicmVzb2x2ZSIsImRldmljZU5hbWUiLCJhdmQiLCJzZXR1cE5ld0lPU0RyaXZlciIsImlvc0FyZ3MiLCJqYXZhc2NyaXB0RW5hYmxlZCIsImlvc2RyaXZlciIsIlhDVUlUZXN0RHJpdmVyIiwicGxhdGZvcm1WZXJzaW9uIiwibWFqb3JWZXIiLCJ0b1N0cmluZyIsInNwbGl0IiwicGFyc2VJbnQiLCJJT1NEcml2ZXIiLCJjYXBzQ29weSIsIl8iLCJjbG9uZURlZXAiLCJuZXdDb21tYW5kVGltZW91dCIsImluZm8iLCJzZXR1cE5ld0FuZHJvaWREcml2ZXIiLCJhbmRyb2lkQXJncyIsImFuZHJvaWRkcml2ZXIiLCJBbmRyb2lkRHJpdmVyIiwic2V0dXBOZXdNYWNEcml2ZXIiLCJtYWNBcmdzIiwibWFjZHJpdmVyIiwiTWFjRHJpdmVyIiwicmV0cnlDb3VudCIsImNvbm5lY3RlZCIsImVycm5vIiwiY29ubmVjdGVkUHJvbWlzZSIsIkIiLCJuZXQiLCJIT1NUIiwiUE9SVCIsInlvdWlFbmdpbmVBcHBQb3J0IiwiU29ja2V0Iiwic2V0VGltZW91dCIsInNldEtlZXBBbGl2ZSIsInNvY2tldENsaWVudCIsInJlbW92ZUxpc3RlbmVySGFuZGxlciIsInJlbW92ZUxpc3RlbmVyIiwidGltZW91dEhhbmRsZXIiLCJjbG9zZUhhbmRsZXIiLCJlbmRIYW5kbGVyIiwiZXJyb3JIYW5kbGVyIiwiZXgiLCJlcnJvciIsIm9uIiwiY29ubmVjdCIsImV4ZWN1dGVTb2NrZXRDb21tYW5kIiwid3JpdGFibGUiLCJjbWRQcm9taXNlIiwidG90YWxkYXRhIiwiZW5kTWFya2VyIiwiQnVmZmVyIiwiZnJvbSIsImRhdGFIYW5kbGVyIiwiZGF0YSIsImxlbmd0aCIsImRhdGFlbmQiLCJhbGxvYyIsInN0YXJ0SW5kZXgiLCJjb3B5IiwiZXF1YWxzIiwibGFzdERhdGEiLCJzbGljZSIsInB1c2giLCJ3cml0ZSIsIkVycm9yIiwiZm4iLCJ0b1BhaXJzIiwiY29tbWFuZHMiLCJwcm90b3R5cGUiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBR0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBTUEsTUFBTUEsZUFBZSxHQUFHLENBQ3RCLFlBRHNCLEVBRXRCLFVBRnNCLEVBR3RCLFFBSHNCLEVBSXRCLGFBSnNCLEVBS3RCLGdCQUxzQixFQU10QixZQU5zQixFQU90QixZQVBzQixFQVF0QixXQVJzQixFQVN0QixNQVRzQixFQVV0QixXQVZzQixFQVd0QixnQkFYc0IsQ0FBeEI7QUFjQSxNQUFNQyxpQkFBaUIsR0FBRyxDQUN4QixhQUR3QixDQUExQjtBQUlBLE1BQU1DLHFCQUFxQixHQUFHLENBQzVCLHNCQUQ0QixFQUU1QixnQkFGNEIsRUFHNUIsVUFINEIsRUFJNUIsa0JBSjRCLEVBSzVCLGNBTDRCLEVBTTVCLHNCQU40QixFQU81Qix3QkFQNEIsRUFRNUIsUUFSNEIsQ0FBOUI7QUFXQSxNQUFNQyxZQUFZLEdBQUdGLGlCQUFpQixDQUFDRyxNQUFsQixDQUF5QkosZUFBekIsQ0FBckI7QUFDQSxNQUFNSyxnQkFBZ0IsR0FBR0gscUJBQXFCLENBQUNFLE1BQXRCLENBQTZCSixlQUE3QixDQUF6QjtBQUNBLE1BQU1NLFlBQVksR0FBR04s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QjtBQUNBbEIsVUFBQUEsWUFBWSxDQUFDUyxFQUFiLENBQWdCLFNBQWhCLEVBQTJCTixjQUEzQjtBQUNBSCxVQUFBQSxZQUFZLENBQUNTLEVBQWIsQ0FBZ0IsT0FBaEIsRUFBeUJILFlBQXpCO0FBQ0QsU0FKRDtBQUtELE9BckRnQixDQUFqQjtBQXNEQSxVQUFJckQsR0FBRyxHQUFHLE1BQU00RCxVQUFoQjs7QUFDQSxVQUFJNUQsR0FBRyxLQUFLLEtBQVosRUFBbUI7QUFDakJtQyxRQUFBQSxVQUFVOztBQUNWakUsd0JBQU93RCxJQUFQLENBQVksOEJBQThCUyxVQUExQzs7QUFDQTtBQUNELE9BSkQsTUFJTztBQUNMLGVBQU9uQyxHQUFQO0FBQ0Q7QUFDRjs7QUFDRCxVQUFNLElBQUk2RSxLQUFKLENBQVUsOEJBQVYsQ0FBTjtBQUNEOztBQXRidUM7Ozs7QUF5YjFDLEtBQUssSUFBSSxDQUFDdEYsR0FBRCxFQUFNdUYsRUFBTixDQUFULElBQXNCdkQsZ0JBQUV3RCxPQUFGLENBQVVDLGlCQUFWLENBQXRCLEVBQTJDO0FBQ3pDcEosRUFBQUEsZ0JBQWdCLENBQUNxSixTQUFqQixDQUEyQjFGLEdBQTNCLElBQWtDdUYsRUFBbEM7QUFDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEJhc2VEcml2ZXIsIERldmljZVNldHRpbmdzLCBlcnJvcnMgfSBmcm9tICdhcHBpdW0tYmFzZS1kcml2ZXInO1xuaW1wb3J0IHsgZGVzaXJlZENhcENvbnN0cmFpbnRzIH0gZnJvbSAnLi9kZXNpcmVkLWNhcHMnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgY29tbWFuZHMgZnJvbSAnLi9jb21tYW5kcyc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IEIgZnJvbSAnYmx1ZWJpcmQnO1xuaW1wb3J0IHsgc2xlZXAgfSBmcm9tICdhc3luY2JveCc7XG5cbi8vIGZvciBwcm94aWVzXG5pbXBvcnQgQW5kcm9pZERyaXZlciBmcm9tICdhcHBpdW0tYW5kcm9pZC1kcml2ZXInO1xuaW1wb3J0IElPU0RyaXZlciBmcm9tICdhcHBpdW0taW9zLWRyaXZlcic7XG5pbXBvcnQgWENVSVRlc3REcml2ZXIgZnJvbSAnYXBwaXVtLXhjdWl0ZXN0LWRyaXZlcic7XG5pbXBvcnQgTWFjRHJpdmVyIGZyb20gJ2FwcGl1bS1tYWMtZHJpdmVyJztcbmltcG9ydCBCbHVlU2t5IGZyb20gJy4vYmx1ZXNreSc7XG5pbXBvcnQgVHZPcyBmcm9tICcuL3R2b3MnO1xuaW1wb3J0IFR2T3NTaW11bGF0b3IgZnJvbSAnLi90dm9zc2ltdWxhdG9yJztcbmltcG9ydCBZaU1hYyBmcm9tICcuL3lpbWFjJztcblxuXG4vLyBBZGQgY29tbWFuZHMgZnJvbSB0aGUgZm9sbG93aW5nIGxvY2F0aW9uIHRoYXQgc2hvdWxkIGJlIG1hcHBlZCB0byBleGlzdGluZyBkcml2ZXJzOlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL2FwcGl1bS9hcHBpdW0tYmFzZS1kcml2ZXIvYmxvYi9tYXN0ZXIvbGliL21qc29ud3Avcm91dGVzLmpzXG5cbmNvbnN0IFRPX1BST1hZX0NPTU1PTiA9IFtcbiAgJ2JhY2tncm91bmQnLFxuICAnY2xvc2VBcHAnLFxuICAnZ2V0TG9nJyxcbiAgJ2dldExvZ1R5cGVzJyxcbiAgJ2dldE9yaWVudGF0aW9uJyxcbiAgJ2dldFN0cmluZ3MnLFxuICAnaW5zdGFsbEFwcCcsXG4gICdsYXVuY2hBcHAnLFxuICAnbG9jaycsXG4gICdyZW1vdmVBcHAnLFxuICAnc2V0T3JpZW50YXRpb24nLFxuXTtcblxuY29uc3QgVE9fUFJPWFlfSU9TX09OTFkgPSBbXG4gICdtb2JpbGVTaGFrZScsXG5dO1xuXG5jb25zdCBUT19QUk9YWV9BTkRST0lEX09OTFkgPSBbXG4gICdnZXROZXR3b3JrQ29ubmVjdGlvbicsXG4gICdpc0FwcEluc3RhbGxlZCcsXG4gICdpc0xvY2tlZCcsXG4gICdsb25nUHJlc3NLZXlDb2RlJyxcbiAgJ3ByZXNzS2V5Q29kZScsXG4gICdzZXROZXR3b3JrQ29ubmVjdGlvbicsXG4gICd0b2dnbGVMb2NhdGlvblNlcnZpY2VzJyxcbiAgJ3VubG9jaycsXG5dO1xuXG5jb25zdCBUT19QUk9YWV9JT1MgPSBUT19QUk9YWV9JT1NfT05MWS5jb25jYXQoVE9fUFJPWFlfQ09NTU9OKTtcbmNvbnN0IFRPX1BST1hZX0FORFJPSUQgPSBUT19QUk9YWV9BTkRST0lEX09OTFkuY29uY2F0KFRPX1BST1hZX0NPTU1PTik7XG5jb25zdCBUT19QUk9YWV9NQUMgPSBUT19QUk9YWV9DT01NT047XG5cbmNvbnN0IE1BWF9SRVRSWV9DT1VOVCA9IDM7XG5jb25zdCBTT0NLRVRfVElNRU9VVCA9IDEwMDAwO1xuXG5jbGFzcyBZb3VpRW5naW5lRHJpdmVyIGV4dGVuZHMgQmFzZURyaXZlciB7XG4gIHJlc2V0WW91aUVuZ2luZSAoKSB7XG5cbiAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5zb2NrZXQgPSBudWxsO1xuICAgIHRoaXMubG9jYXRvclN0cmF0ZWdpZXMgPSBbJ2lkJywgJ25hbWUnLCAnY2xhc3MgbmFtZScsICdhY2Nlc3NpYmlsaXR5IGlkJ107XG4gICAgdGhpcy5wcm94eWRyaXZlciA9IG51bGw7XG4gICAgdGhpcy5wcm94eUFsbG93TGlzdCA9ICcnO1xuICAgIHRoaXMuZGV2aWNlID0gbnVsbDtcbiAgfVxuXG4gIGNvbnN0cnVjdG9yIChvcHRzLCBzaG91bGRWYWxpZGF0ZUNhcHMpIHtcbiAgICBzdXBlcihvcHRzLCBzaG91bGRWYWxpZGF0ZUNhcHMpO1xuXG4gICAgdGhpcy5kZXNpcmVkQ2FwQ29uc3RyYWludHMgPSBkZXNpcmVkQ2FwQ29uc3RyYWludHM7XG4gICAgdGhpcy5zZXR0aW5ncyA9IG5ldyBEZXZpY2VTZXR0aW5ncyh7J1RpbWVEaWxhdGlvbic6IDEsICdTb3VyY2VUcmVlRmlsdGVyJzogJyd9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLm9uU2V0dGluZ3NVcGRhdGUuYmluZCh0aGlzKSk7XG4gICAgdGhpcy5yZXNldFlvdWlFbmdpbmUoKTtcblxuICB9XG5cbiAgdmFsaWRhdGVMb2NhdG9yU3RyYXRlZ3kgKHN0cmF0ZWd5KSB7XG4gICAgc3VwZXIudmFsaWRhdGVMb2NhdG9yU3RyYXRlZ3koc3RyYXRlZ3ksIGZhbHNlKTtcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZVNlc3Npb24gKGNhcHMpIHtcbiAgICB0cnkge1xuICAgICAgbGV0IFtzZXNzaW9uSWRdID0gYXdhaXQgc3VwZXIuY3JlYXRlU2Vzc2lvbihjYXBzKTtcblxuICAgICAgLy8gc2V0dXAgcHJveGllcyAtIGlmIHBsYXRmb3JtTmFtZSBpcyBub3QgZW1wdHksIG1ha2UgaXQgbGVzcyBjYXNlIHNlbnNpdGl2ZVxuICAgICAgaWYgKGNhcHMucGxhdGZvcm1OYW1lICE9PSBudWxsKSB7XG4gICAgICAgIGxldCBhcHBQbGF0Zm9ybSA9IGNhcHMucGxhdGZvcm1OYW1lLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIHN3aXRjaCAoYXBwUGxhdGZvcm0pIHtcbiAgICAgICAgICBjYXNlICdpb3MnOlxuICAgICAgICAgICAgYXdhaXQgdGhpcy5zdGFydElPU1Nlc3Npb24oY2Fwcyk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdhbmRyb2lkJzpcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc3RhcnRBbmRyb2lkU2Vzc2lvbihjYXBzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ21hYyc6XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnN0YXJ0TWFjU2Vzc2lvbihjYXBzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ3lpbWFjJzpcbiAgICAgICAgICAgIHRoaXMuZGV2aWNlID0gbmV3IFlpTWFjKCk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRldmljZS5zdGFydFNlc3Npb24oY2Fwcyk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdibHVlc2t5JzpcbiAgICAgICAgICAgIHRoaXMuZGV2aWNlID0gbmV3IEJsdWVTa3koKTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZGV2aWNlLnN0YXJ0U2Vzc2lvbihjYXBzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ3lpdHZvcyc6IHtcbiAgICAgICAgICAgIGxldCBzaGVsbCA9IHJlcXVpcmUoJ3NoZWxsanMnKTtcbiAgICAgICAgICAgIGlmIChzaGVsbC5leGVjKGBpbnN0cnVtZW50cyAtcyBkZXZpY2VzIHwgZ3JlcCAnJHtjYXBzLnVkaWR9J2ApLmluY2x1ZGVzKCcoU2ltdWxhdG9yKScpKSB7XG4gICAgICAgICAgICAgIHRoaXMuZGV2aWNlID0gbmV3IFR2T3NTaW11bGF0b3IoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRoaXMuZGV2aWNlID0gbmV3IFR2T3MoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZGV2aWNlLnN0YXJ0U2Vzc2lvbihjYXBzLCB0aGlzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjYXNlICdub3Byb3h5JzpcbiAgICAgICAgICBjYXNlICdjb25uZWN0dG9hcHAnOlxuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvckFuZFRocm93KGBVbnN1cHBvcnRlZCBwbGF0Zm9ybU5hbWU6ICR7Y2Fwcy5wbGF0Zm9ybU5hbWV9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuY29ubmVjdFNvY2tldCgpO1xuXG4gICAgICBpZiAoY2Fwcy5mdWxsU291cmNlVHJlZSA9PT0gdHJ1ZSkge1xuICAgICAgICAvL0RvIG5vdCBzZXQgZmlsdGVyXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2dnZXIuZGVidWcoJ1NldHRpbmcgU291cmNlVHJlZUZpbHRlciB0byBkaXNwbGF5ZWQgZWxlbWVudHMgb25seScpO1xuICAgICAgICBhd2FpdCB0aGlzLnVwZGF0ZVNldHRpbmdzKHtTb3VyY2VUcmVlRmlsdGVyOiBcIltAaXNEaXNwbGF5ZWQ9J3RydWUnXVwifSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBbc2Vzc2lvbklkLCB0aGlzLm9wdHNdO1xuXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgYXdhaXQgdGhpcy5kZWxldGVTZXNzaW9uKCk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG9uU2V0dGluZ3NVcGRhdGUgKGtleSwgdmFsdWUpIHtcbiAgICBpZiAoa2V5ID09PSAnVGltZURpbGF0aW9uJykge1xuICAgICAgYXdhaXQgdGhpcy5zZXRUaW1lRGlsYXRpb24odmFsdWUpO1xuICAgIH0gZWxzZSBpZiAoa2V5ID09PSAnU291cmNlVHJlZUZpbHRlcicpIHtcbiAgICAgIGF3YWl0IHRoaXMuc2V0U291cmNlVHJlZUZpbHRlcih2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgc3RvcCAoKSB7IC8vIGVzbGludC1kaXNhYmxlLWxpbmUgcmVxdWlyZS1hd2FpdFxuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgfVxuXG4gIGFzeW5jIGRlbGV0ZVNlc3Npb24gKCkge1xuICAgIGxvZ2dlci5kZWJ1ZygnRGVsZXRpbmcgWW91aUVuZ2luZSBzZXNzaW9uJyk7XG5cbiAgICBpZiAodGhpcy5jYXBzLnBsYXRmb3JtTmFtZSAhPT0gbnVsbCkge1xuICAgICAgbGV0IGFwcFBsYXRmb3JtID0gdGhpcy5jYXBzLnBsYXRmb3JtTmFtZS50b0xvd2VyQ2FzZSgpO1xuXG4gICAgICBpZiAoWyd5aW1hYycsICd5aXR2b3MnLCAnYmx1ZXNreSddLmluY2x1ZGVzKGFwcFBsYXRmb3JtKSkge1xuICAgICAgICBpZiAodGhpcy5kZXZpY2UpIHtcbiAgICAgICAgICB0aGlzLmRldmljZS5lbmRTZXNzaW9uKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5wcm94eWRyaXZlciAhPT0gbnVsbCkge1xuICAgICAgYXdhaXQgdGhpcy5wcm94eWRyaXZlci5kZWxldGVTZXNzaW9uKCk7XG4gICAgfVxuICAgIHRoaXMuc29ja2V0LmVuZCgpO1xuICAgIHRoaXMuc29ja2V0LmRlc3Ryb3koKTtcbiAgICBhd2FpdCBzdXBlci5kZWxldGVTZXNzaW9uKCk7XG4gICAgYXdhaXQgdGhpcy5zdG9wKCk7XG4gIH1cblxuICBkcml2ZXJTaG91bGREb1Byb3h5Q21kIChjb21tYW5kKSB7XG4gICAgaWYgKCF0aGlzLnByb3h5ZHJpdmVyKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gb25seSBhbGxvdyB3aGl0ZSBsaXN0ZWQgY29tbWFuZHNcbiAgICBmb3IgKGxldCBhbGxvd2VkQ29tbWFuZCBvZiB0aGlzLnByb3h5QWxsb3dMaXN0KSB7XG4gICAgICBpZiAoYWxsb3dlZENvbW1hbmQgPT09IGNvbW1hbmQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGFzeW5jIGV4ZWN1dGVDb21tYW5kIChjbWQsIC4uLmFyZ3MpIHtcbiAgICBpZiAoY21kID09PSAncmVjZWl2ZUFzeW5jUmVzcG9uc2UnKSB7XG4gICAgICBsb2dnZXIuZGVidWcoYEV4ZWN1dGluZyBZb3VpRW5naW5lRHJpdmVyIHJlc3BvbnNlICcke2NtZH0nYCk7XG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5yZWNlaXZlQXN5bmNSZXNwb25zZSguLi5hcmdzKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMucmVhZHkpIHtcblxuICAgICAgaWYgKHRoaXMuZHJpdmVyU2hvdWxkRG9Qcm94eUNtZChjbWQpKSB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhgRXhlY3V0aW5nIHByb3hpZWQgV2ViRHJpdmVyIGNvbW1hbmQgJyR7Y21kfSdgKTtcblxuICAgICAgICAvLyBUaGVyZSBhcmUgMiBDb21tYW5kVGltZW91dCAoWW91aUVuZ2luZURyaXZlciBhbmQgcHJveHkpXG4gICAgICAgIC8vIE9ubHkgWW91aUVuZ2luZURyaXZlciBDb21tYW5kVGltZW91dCBpcyB1c2VkOyBQcm94eSBpcyBkaXNhYmxlZFxuICAgICAgICAvLyBBbGwgcHJveHkgY29tbWFuZHMgbmVlZHMgdG8gcmVzZXQgdGhlIFlvdWlFbmdpbmVEcml2ZXIgQ29tbWFuZFRpbWVvdXRcbiAgICAgICAgLy8gSGVyZSB3ZSBtYW51YWxseSByZXNldCB0aGUgWW91aUVuZ2luZURyaXZlciBDb21tYW5kVGltZW91dCBmb3IgY29tbWFuZHMgdGhhdCBnb2UgdG8gcHJveHkuXG4gICAgICAgIHRoaXMuY2xlYXJOZXdDb21tYW5kVGltZW91dCgpO1xuICAgICAgICBsZXQgcmVzdWx0ID0gdGhpcy5wcm94eWRyaXZlci5leGVjdXRlQ29tbWFuZChjbWQsIC4uLmFyZ3MpO1xuICAgICAgICB0aGlzLnN0YXJ0TmV3Q29tbWFuZFRpbWVvdXQoY21kKTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhgRXhlY3V0aW5nIFlvdWlFbmdpbmUgV2ViRHJpdmVyIGNvbW1hbmQgJyR7Y21kfSdgKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmV4ZWN1dGVDb21tYW5kKGNtZCwgLi4uYXJncyk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgQ29tbWFuZCBFcnJvciAnJHtjbWR9J2ApO1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hEcml2ZXJFcnJvcihgRHJpdmVyIGlzIG5vdCByZWFkeSwgY2Fubm90IGV4ZWN1dGUgJHtjbWR9LmApO1xuICAgIH1cbiAgfVxuXG4gIHZhbGlkYXRlRGVzaXJlZENhcHMgKGNhcHMpIHtcbiAgICAvLyBjaGVjayB3aXRoIHRoZSBiYXNlIGNsYXNzLCBhbmQgcmV0dXJuIGlmIGl0IGZhaWxzXG4gICAgbGV0IHJlcyA9IHN1cGVyLnZhbGlkYXRlRGVzaXJlZENhcHMoY2Fwcyk7XG4gICAgaWYgKCFyZXMpIHtcbiAgICAgIHJldHVybiByZXM7XG4gICAgfVxuXG4gICAgLy8gbWFrZSBzdXJlIHRoYXQgdGhlIGNhcGFiaWxpdGllcyBoYXMgeW91aUVuZ2luZUFwcEFkZHJlc3NcbiAgICBpZiAoIWNhcHMueW91aUVuZ2luZUFwcEFkZHJlc3MpIHtcbiAgICAgIGxldCBtc2cgPSAnVGhlIGRlc2lyZWQgY2FwYWJpbGl0aWVzIG11c3QgaW5jbHVkZSB5b3VpRW5naW5lQXBwQWRkcmVzcyc7XG4gICAgICBsb2dnZXIuZXJyb3JBbmRUaHJvdyhtc2cpO1xuICAgIH1cblxuICAgIC8vIEFwcCBpcyBiZWluZyBsYXVuY2hlZFxuICAgIGlmIChjYXBzLnBsYXRmb3JtTmFtZS50b0xvd2VyQ2FzZSgpICE9PSAnY29ubmVjdHRvYXBwJyAmJiBjYXBzLnBsYXRmb3JtTmFtZS50b0xvd2VyQ2FzZSgpICE9PSAnbm9wcm94eScpIHtcblxuICAgICAgLy8gbWFrZSBzdXJlIHRoYXQgdGhlIGNhcGFiaWxpdGllcyBoYXMgYXBwXG4gICAgICBpZiAoIWNhcHMuYXBwKSB7XG4gICAgICAgIGxldCBtc2cgPSAnVGhlIGRlc2lyZWQgY2FwYWJpbGl0aWVzIG11c3QgaW5jbHVkZSBhcHAnO1xuICAgICAgICBsb2dnZXIuZXJyb3JBbmRUaHJvdyhtc2cpO1xuICAgICAgfVxuICAgICAgY29uc3QgZnMgPSByZXF1aXJlKCdmcycpO1xuICAgICAgY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbiAgICAgIGlmICghZnMuZXhpc3RzU3luYyhjYXBzLmFwcCkpIHtcbiAgICAgICAgbGV0IGFic29sdXRlcGF0aCA9IHBhdGgucmVzb2x2ZShjYXBzLmFwcCk7XG4gICAgICAgIGxldCBtc2cgPSAnVGhlIGFwcCBjb3VsZCBub3QgYmUgZm91bmQgaW4gZm9sbG93aW5nIGxvY2F0aW9uOiAnICsgYWJzb2x1dGVwYXRoO1xuICAgICAgICBsb2dnZXIuZXJyb3JBbmRUaHJvdyhtc2cpO1xuICAgICAgfVxuXG4gICAgICAvL0FuZHJvaWQgZW11bGF0b3Igd2l0aCBwcm94eVxuICAgICAgaWYgKGNhcHMuZGV2aWNlTmFtZS50b0xvd2VyQ2FzZSgpID09PSAnYW5kcm9pZCcpIHtcbiAgICAgICAgaWYgKCFjYXBzLmF2ZCkge1xuICAgICAgICAgIGxldCBtc2cgPSAnVGhlIGRlc2lyZWQgY2FwYWJpbGl0aWVzIG11c3QgaW5jbHVkZSBhdmQnO1xuICAgICAgICAgIGxvZ2dlci5lcnJvckFuZFRocm93KG1zZyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBmaW5hbGx5LCByZXR1cm4gdHJ1ZSBzaW5jZSB0aGUgc3VwZXJjbGFzcyBjaGVjayBwYXNzZWQsIGFzIGRpZCB0aGlzXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBhc3luYyBzZXR1cE5ld0lPU0RyaXZlciAoY2Fwcykge1xuICAgIGxldCBpb3NBcmdzID0ge1xuICAgICAgamF2YXNjcmlwdEVuYWJsZWQ6IHRydWUsXG4gICAgfTtcblxuICAgIGxldCBpb3Nkcml2ZXIgPSBuZXcgWENVSVRlc3REcml2ZXIoaW9zQXJncyk7XG4gICAgLy8gSWYgaU9TIHZlcnNpb24gaXMgMTAgb3IgYWJvdmUgd2UgbmVlZCB0byB1c2UgWENVSVRlc3REcml2ZXIgKGFuZCBYY29kZSA4KylcbiAgICBpZiAoY2Fwcy5wbGF0Zm9ybVZlcnNpb24pIHtcbiAgICAgIGxldCBtYWpvclZlciA9IGNhcHMucGxhdGZvcm1WZXJzaW9uLnRvU3RyaW5nKCkuc3BsaXQoJy4nKVswXTtcbiAgICAgIGlmIChwYXJzZUludChtYWpvclZlciwgMTApIDwgMTApIHtcbiAgICAgICAgaW9zZHJpdmVyID0gbmV3IElPU0RyaXZlcihpb3NBcmdzKTtcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IGNhcHNDb3B5ID0gXy5jbG9uZURlZXAoY2Fwcyk7XG4gICAgLy8gRGlzYWJsaW5nIHRoZSBwcm94eSBDb21tYW5kVGltZW91dCBpbiB0aGUgaU9TIGRyaXZlciBzaW5jZSB3ZSBhcmUgbm93IGhhbmRsaW5nIGl0IGluIHRoZSBZb3VpRW5naW5lIERyaXZlclxuICAgIGNhcHNDb3B5Lm5ld0NvbW1hbmRUaW1lb3V0ID0gMDtcbiAgICBhd2FpdCBpb3Nkcml2ZXIuY3JlYXRlU2Vzc2lvbihjYXBzQ29weSk7XG5cbiAgICByZXR1cm4gaW9zZHJpdmVyO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRJT1NTZXNzaW9uIChjYXBzKSB7XG4gICAgbG9nZ2VyLmluZm8oJ1N0YXJ0aW5nIGFuIElPUyBwcm94eSBzZXNzaW9uJyk7XG4gICAgdGhpcy5wcm94eUFsbG93TGlzdCA9IFRPX1BST1hZX0lPUztcblxuICAgIHRoaXMucHJveHlkcml2ZXIgPSBhd2FpdCB0aGlzLnNldHVwTmV3SU9TRHJpdmVyKGNhcHMpO1xuICB9XG5cbiAgYXN5bmMgc2V0dXBOZXdBbmRyb2lkRHJpdmVyIChjYXBzKSB7XG4gICAgbGV0IGFuZHJvaWRBcmdzID0ge1xuICAgICAgamF2YXNjcmlwdEVuYWJsZWQ6IHRydWVcbiAgICB9O1xuICAgIGxldCBhbmRyb2lkZHJpdmVyID0gbmV3IEFuZHJvaWREcml2ZXIoYW5kcm9pZEFyZ3MpO1xuICAgIGxldCBjYXBzQ29weSA9IF8uY2xvbmVEZWVwKGNhcHMpO1xuICAgIC8vIERpc2FibGluZyB0aGUgcHJveHkgQ29tbWFuZFRpbWVvdXQgaW4gdGhlIEFuZHJvaWQgZHJpdmVyIHNpbmNlIHdlIGFyZSBub3cgaGFuZGxpbmcgaXQgaW4gdGhlIFlvdWlFbmdpbmUgRHJpdmVyXG4gICAgY2Fwc0NvcHkubmV3Q29tbWFuZFRpbWVvdXQgPSAwO1xuXG4gICAgYXdhaXQgYW5kcm9pZGRyaXZlci5jcmVhdGVTZXNzaW9uKGNhcHNDb3B5KTtcblxuICAgIHJldHVybiBhbmRyb2lkZHJpdmVyO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRBbmRyb2lkU2Vzc2lvbiAoY2Fwcykge1xuICAgIGxvZ2dlci5pbmZvKCdTdGFydGluZyBhbiBBbmRyb2lkIHByb3h5IHNlc3Npb24nKTtcbiAgICB0aGlzLnByb3h5QWxsb3dMaXN0ID0gVE9fUFJPWFlfQU5EUk9JRDtcblxuICAgIHRoaXMucHJveHlkcml2ZXIgPSBhd2FpdCB0aGlzLnNldHVwTmV3QW5kcm9pZERyaXZlcihjYXBzKTtcbiAgfVxuXG4gIGFzeW5jIHNldHVwTmV3TWFjRHJpdmVyIChjYXBzKSB7XG4gICAgbGV0IG1hY0FyZ3MgPSB7XG4gICAgICBqYXZhc2NyaXB0RW5hYmxlZDogdHJ1ZVxuICAgIH07XG4gICAgbGV0IG1hY2RyaXZlciA9IG5ldyBNYWNEcml2ZXIobWFjQXJncyk7XG4gICAgbGV0IGNhcHNDb3B5ID0gXy5jbG9uZURlZXAoY2Fwcyk7XG4gICAgLy8gRGlzYWJsaW5nIHRoZSBwcm94eSBDb21tYW5kVGltZW91dCBpbiB0aGUgcHJveGllZCBkcml2ZXIgc2luY2Ugd2UgYXJlIG5vdyBoYW5kbGluZyBpdCBpbiB0aGUgWW91aUVuZ2luZSBEcml2ZXJcbiAgICBjYXBzQ29weS5uZXdDb21tYW5kVGltZW91dCA9IDA7XG5cbiAgICBhd2FpdCBtYWNkcml2ZXIuY3JlYXRlU2Vzc2lvbihjYXBzQ29weSk7XG5cbiAgICByZXR1cm4gbWFjZHJpdmVyO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNYWNTZXNzaW9uIChjYXBzKSB7XG4gICAgbG9nZ2VyLmluZm8oJ1N0YXJ0aW5nIGEgTWFjIHByb3h5IHNlc3Npb24nKTtcbiAgICB0aGlzLnByb3h5QWxsb3dMaXN0ID0gVE9fUFJPWFlfTUFDO1xuXG4gICAgdGhpcy5wcm94eWRyaXZlciA9IGF3YWl0IHRoaXMuc2V0dXBOZXdNYWNEcml2ZXIoY2Fwcyk7XG4gIH1cblxuICAvLyBTT0NLRVRTXG4gIGFzeW5jIGNvbm5lY3RTb2NrZXQgKCkge1xuICAgIGxldCByZXRyeUNvdW50ID0gMDtcbiAgICBsZXQgY29ubmVjdGVkID0gZmFsc2U7XG4gICAgbGV0IGVycm5vID0gJ0VPSyc7XG4gICAgd2hpbGUgKHJldHJ5Q291bnQgPCBNQVhfUkVUUllfQ09VTlQgJiYgIWNvbm5lY3RlZCkge1xuICAgICAgbG9nZ2VyLmluZm8oJ0F0dGVtcHQgIycgKyAocmV0cnlDb3VudCArIDEpKTtcblxuICAgICAgbGV0IGNvbm5lY3RlZFByb21pc2UgPSBuZXcgQigocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgbmV0ID0gcmVxdWlyZSgnbmV0Jyk7XG5cbiAgICAgICAgbGV0IEhPU1QgPSB0aGlzLm9wdHMueW91aUVuZ2luZUFwcEFkZHJlc3M7XG4gICAgICAgIGxldCBQT1JUO1xuXG4gICAgICAgIGlmICh0aGlzLmNhcHMueW91aUVuZ2luZUFwcFBvcnQpIHtcbiAgICAgICAgICBQT1JUID0gdGhpcy5jYXBzLnlvdWlFbmdpbmVBcHBQb3J0O1xuICAgICAgICB9IGVsc2UgaWYgKHRoaXMuY2Fwcy5wbGF0Zm9ybU5hbWUudG9Mb3dlckNhc2UoKSA9PT0gJ3lpcHM0Jykge1xuICAgICAgICAgIFBPUlQgPSA0MDEyMzsgLy9kZWZhdWx0IHBvcnQgZm9yIFBTNFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIFBPUlQgPSAxMjM0NTsgLy9kZWZhdWx0IHBvcnRcbiAgICAgICAgfVxuICAgICAgICB7bG9nZ2VyLmluZm8oJ0Nvbm5lY3RpbmcgdG8gV2ViRHJpdmVyOiAnICsgSE9TVCArICc6JyArIFBPUlQpO31cblxuICAgICAgICB0aGlzLnNvY2tldCA9IG5ldyBuZXQuU29ja2V0KCk7XG4gICAgICAgIHRoaXMuc29ja2V0LnNldFRpbWVvdXQoU09DS0VUX1RJTUVPVVQpO1xuICAgICAgICB0aGlzLnNvY2tldC5zZXRLZWVwQWxpdmUodHJ1ZSwgMTAwMCk7XG5cbiAgICAgICAgbGV0IHNvY2tldENsaWVudCA9IHRoaXMuc29ja2V0O1xuXG4gICAgICAgIGxldCByZW1vdmVMaXN0ZW5lckhhbmRsZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgc29ja2V0Q2xpZW50LnJlbW92ZUxpc3RlbmVyKCd0aW1lb3V0JywgdGltZW91dEhhbmRsZXIpO1xuICAgICAgICAgIHNvY2tldENsaWVudC5yZW1vdmVMaXN0ZW5lcignY2xvc2UnLCBjbG9zZUhhbmRsZXIpO1xuICAgICAgICAgIHNvY2tldENsaWVudC5yZW1vdmVMaXN0ZW5lcignZW5kJywgZW5kSGFuZGxlcik7XG4gICAgICAgICAgc29ja2V0Q2xpZW50LnJlbW92ZUxpc3RlbmVyKCdlcnJvcicsIGVycm9ySGFuZGxlcik7XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gQWRkIGFuICdlcnJvcicgZXZlbnQgaGFuZGxlciBmb3IgdGhlIGNsaWVudCBzb2NrZXRcbiAgICAgICAgbGV0IGVycm9ySGFuZGxlciA9IGZ1bmN0aW9uIChleCkge1xuICAgICAgICAgIGxvZ2dlci5lcnJvcihleCk7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdDaGVjayB0aGF0IFdlYkRyaXZlciBpcyBlbmFibGVkIGluIGFwcGxpY2F0aW9uLCBpZiBhIGRldmljZSBlbnN1cmUgdGhlIHByb3BlciBJUCBhZGRyZXNzIGlzIHVzZWQuJyk7XG4gICAgICAgICAgcmVtb3ZlTGlzdGVuZXJIYW5kbGVyKCk7XG4gICAgICAgICAgc29ja2V0Q2xpZW50LmRlc3Ryb3koKTtcbiAgICAgICAgICBlcnJubyA9IGV4LmVycm5vO1xuICAgICAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgICAgICB9O1xuICAgICAgICB0aGlzLnNvY2tldC5vbiAoJ2Vycm9yJywgZXJyb3JIYW5kbGVyKTtcbiAgICAgICAgLy8gQWRkIGEgJ2Nsb3NlJyBldmVudCBoYW5kbGVyIGZvciB0aGUgY2xpZW50IHNvY2tldFxuICAgICAgICBsZXQgY2xvc2VIYW5kbGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIGxvZ2dlci5pbmZvKCdDb25uZWN0aW9uIGNsb3NlZCcpO1xuICAgICAgICAgIHJlbW92ZUxpc3RlbmVySGFuZGxlcigpO1xuICAgICAgICAgIHNvY2tldENsaWVudC5kZXN0cm95KCk7XG4gICAgICAgICAgcmVzb2x2ZShmYWxzZSk7XG4gICAgICAgIH07XG4gICAgICAgIHRoaXMuc29ja2V0Lm9uICgnY2xvc2UnLCBjbG9zZUhhbmRsZXIpO1xuICAgICAgICAvLyBBZGQgYSAndGltZW91dCcgZXZlbnQgaGFuZGxlciBmb3IgdGhlIGNsaWVudCBzb2NrZXRcbiAgICAgICAgbGV0IHRpbWVvdXRIYW5kbGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIGxvZ2dlci5lcnJvcignQ29ubmVjdGlvbiB0aW1lZCBvdXQnKTtcbiAgICAgICAgICByZW1vdmVMaXN0ZW5lckhhbmRsZXIoKTtcbiAgICAgICAgICBzb2NrZXRDbGllbnQuZGVzdHJveSgpO1xuICAgICAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgICAgICB9O1xuICAgICAgICB0aGlzLnNvY2tldC5vbiAoJ3RpbWVvdXQnLCB0aW1lb3V0SGFuZGxlcik7XG4gICAgICAgIHRoaXMuc29ja2V0LmNvbm5lY3QgKFBPUlQsIEhPU1QsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0Nvbm5lY3Rpb24gZXN0YWJsaXNoZWQnKTtcbiAgICAgICAgICByZW1vdmVMaXN0ZW5lckhhbmRsZXIoKTtcbiAgICAgICAgICByZXNvbHZlKHRydWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgbGV0IGVuZEhhbmRsZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgbG9nZ2VyLmluZm8oJ0Nvbm5lY3Rpb24gZW5kZWQnKTtcbiAgICAgICAgICByZW1vdmVMaXN0ZW5lckhhbmRsZXIoKTtcbiAgICAgICAgICBzb2NrZXRDbGllbnQuZGVzdHJveSgpO1xuICAgICAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgICAgICB9O1xuICAgICAgICB0aGlzLnNvY2tldC5vbignZW5kJywgZW5kSGFuZGxlcik7XG4gICAgICB9KTtcbiAgICAgIHJldHJ5Q291bnQrKztcbiAgICAgIGNvbm5lY3RlZCA9IGF3YWl0IGNvbm5lY3RlZFByb21pc2U7XG5cbiAgICAgIGlmICghY29ubmVjdGVkICYmIGVycm5vID09PSAnRUNPTk5SRUZVU0VEJykge1xuICAgICAgICBsb2dnZXIuZGVidWcoJ0Nvbm5lY3Rpb24gcmVmdXNlZCwgc2xlZXBpbmcuLi4nKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwMCk7XG4gICAgICAgIGVycm5vID0gJ0VPSyc7XG4gICAgICB9XG5cbiAgICAgIGlmICghY29ubmVjdGVkICYmIHJldHJ5Q291bnQgPT09IChNQVhfUkVUUllfQ09VTlQgLSAxKSkge1xuICAgICAgICBsb2dnZXIuZXJyb3JBbmRUaHJvdygnRmFpbGVkIHRvIGNvbm5lY3QgJyArIE1BWF9SRVRSWV9DT1VOVCArICcgdGltZXMuIEFib3J0aW5nLicpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXRyeUNvdW50ID0gMDtcbiAgICB0aGlzLnJlYWR5ID0gY29ubmVjdGVkO1xuICB9XG5cbiAgYXN5bmMgZXhlY3V0ZVNvY2tldENvbW1hbmQgKGNtZCkge1xuXG4gICAgaWYgKCF0aGlzLnNvY2tldC53cml0YWJsZSkge1xuICAgICAgbG9nZ2VyLmluZm8oJ1NvY2tldCBpcyBub3Qgd3JpdGFibGUuIFRyeWluZyB0byByZWNvbm5lY3QuJyk7XG4gICAgICBhd2FpdCB0aGlzLmNvbm5lY3RTb2NrZXQoKTtcbiAgICB9XG5cbiAgICBsZXQgcmV0cnlDb3VudCA9IDA7XG4gICAgd2hpbGUgKHJldHJ5Q291bnQgPCBNQVhfUkVUUllfQ09VTlQpIHtcbiAgICAgIHRoaXMuc29ja2V0LnNldFRpbWVvdXQoU09DS0VUX1RJTUVPVVQpO1xuXG4gICAgICBsZXQgY21kUHJvbWlzZSA9IG5ldyBCKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZygnQ09NTUFORDogJyArIGNtZCk7XG5cbiAgICAgICAgbGV0IHRvdGFsZGF0YSA9IFtdO1xuICAgICAgICBsZXQgZW5kTWFya2VyID0gbmV3IEJ1ZmZlci5mcm9tKCd5b3VpZW5kJyk7XG4gICAgICAgIGxldCBzb2NrZXRDbGllbnQgPSB0aGlzLnNvY2tldDtcblxuICAgICAgICBsZXQgcmVtb3ZlTGlzdGVuZXJIYW5kbGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHNvY2tldENsaWVudC5yZW1vdmVMaXN0ZW5lcignZGF0YScsIGRhdGFIYW5kbGVyKTtcbiAgICAgICAgICBzb2NrZXRDbGllbnQucmVtb3ZlTGlzdGVuZXIoJ3RpbWVvdXQnLCB0aW1lb3V0SGFuZGxlcik7XG4gICAgICAgICAgc29ja2V0Q2xpZW50LnJlbW92ZUxpc3RlbmVyKCdlcnJvcicsIGVycm9ySGFuZGxlcik7XG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRpbWVvdXRIYW5kbGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIGxvZ2dlci5pbmZvKCdUaW1lb3V0IGluIGV4ZWN1dGUgY29tbWFuZC4nKTtcbiAgICAgICAgICByZW1vdmVMaXN0ZW5lckhhbmRsZXIoKTtcbiAgICAgICAgICByZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZXJyb3JIYW5kbGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIGxvZ2dlci5pbmZvKCdPbiBlcnJvcicpO1xuICAgICAgICAgIHJlbW92ZUxpc3RlbmVySGFuZGxlcigpO1xuICAgICAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBkYXRhSGFuZGxlciA9IGZ1bmN0aW9uIChkYXRhKSB7XG5cbiAgICAgICAgICAvLyBkZXRlcm1pbmUgaWYgdGhpcyBpbmNsdWRlcyBhbiBlbmQgbWFya2VyXG4gICAgICAgICAgLy8gZ2V0IGxhc3QgZmV3IHZhbHVlcyBvZiBidWZmZXJcbiAgICAgICAgICBpZiAoZGF0YS5sZW5ndGggPj0gZW5kTWFya2VyLmxlbmd0aCkge1xuICAgICAgICAgICAgbGV0IGRhdGFlbmQgPSBuZXcgQnVmZmVyLmFsbG9jKGVuZE1hcmtlci5sZW5ndGgpO1xuICAgICAgICAgICAgbGV0IHN0YXJ0SW5kZXggPSBkYXRhLmxlbmd0aCAtIGVuZE1hcmtlci5sZW5ndGg7XG4gICAgICAgICAgICBkYXRhLmNvcHkoZGF0YWVuZCwgMCwgc3RhcnRJbmRleCwgc3RhcnRJbmRleCArIGVuZE1hcmtlci5sZW5ndGgpO1xuICAgICAgICAgICAgaWYgKGRhdGFlbmQuZXF1YWxzKGVuZE1hcmtlcikpIHtcbiAgICAgICAgICAgICAgLy8gcmVtb3ZlIGRhdGEgZW5kXG4gICAgICAgICAgICAgIGxldCBsYXN0RGF0YSA9IGRhdGEuc2xpY2UoMCwgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgIHRvdGFsZGF0YS5wdXNoKGxhc3REYXRhKTtcblxuICAgICAgICAgICAgICByZW1vdmVMaXN0ZW5lckhhbmRsZXIoKTtcblxuICAgICAgICAgICAgICAvLyByZXNvbHZlXG4gICAgICAgICAgICAgIHJlc29sdmUoQnVmZmVyLmNvbmNhdCh0b3RhbGRhdGEpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRvdGFsZGF0YS5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICBzb2NrZXRDbGllbnQud3JpdGUoY21kICsgJ1xcbicsICdVVEY4JywgKCkgPT4ge1xuICAgICAgICAgIHNvY2tldENsaWVudC5vbignZGF0YScsIGRhdGFIYW5kbGVyKTtcbiAgICAgICAgICBzb2NrZXRDbGllbnQub24oJ3RpbWVvdXQnLCB0aW1lb3V0SGFuZGxlcik7XG4gICAgICAgICAgc29ja2V0Q2xpZW50Lm9uKCdlcnJvcicsIGVycm9ySGFuZGxlcik7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgICBsZXQgcmVzID0gYXdhaXQgY21kUHJvbWlzZTtcbiAgICAgIGlmIChyZXMgPT09IGZhbHNlKSB7XG4gICAgICAgIHJldHJ5Q291bnQrKztcbiAgICAgICAgbG9nZ2VyLmluZm8oJ1NvY2tldCBmYWlsZWQuIFJldHJ5aW5nOiAnICsgcmV0cnlDb3VudCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKCdFeGVjdXRlU29ja2V0Q29tbWFuZCBmYWlsZWQuJyk7XG4gIH1cbn1cblxuZm9yIChsZXQgW2NtZCwgZm5dIG9mIF8udG9QYWlycyhjb21tYW5kcykpIHtcbiAgWW91aUVuZ2luZURyaXZlci5wcm90b3R5cGVbY21kXSA9IGZuO1xufVxuZXhwb3J0IHsgWW91aUVuZ2luZURyaXZlciB9O1xuIl0sImZpbGUiOiJsaWIvZHJpdmVyLmpzIiwic291cmNlUm9vdCI6Ii4uLy4uIn0=
