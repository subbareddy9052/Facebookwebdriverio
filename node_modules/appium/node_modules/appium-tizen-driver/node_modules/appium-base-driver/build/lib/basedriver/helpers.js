"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.configureApp = configureApp;
exports.isPackageOrBundle = isPackageOrBundle;
exports.getCoordDefault = getCoordDefault;
exports.getSwipeTouchDuration = getSwipeTouchDuration;
exports.duplicateKeys = duplicateKeys;
exports.parseCapsArray = parseCapsArray;

require("source-map-support/register");

var _lodash = _interopRequireDefault(require("lodash"));

var _path = _interopRequireDefault(require("path"));

var _url = _interopRequireDefault(require("url"));

var _logger = _interopRequireDefault(require("./logger"));

var _fs2 = _interopRequireDefault(require("fs"));

var _bluebird = _interopRequireDefault(require("bluebird"));

var _appiumSupport = require("appium-support");

var _request = _interopRequireDefault(require("request"));

var _requestPromise = _interopRequireDefault(require("request-promise"));

var _lruCache = _interopRequireDefault(require("lru-cache"));

var _asyncLock = _interopRequireDefault(require("async-lock"));

var _sanitizeFilename = _interopRequireDefault(require("sanitize-filename"));

const ZIP_EXTS = ['.zip', '.ipa'];
const ZIP_MIME_TYPES = ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'];
const APPLICATIONS_CACHE = new _lruCache.default({
  max: 100
});
const APPLICATIONS_CACHE_GUARD = new _asyncLock.default();
const SANITIZE_REPLACEMENT = '-';
const DEFAULT_BASENAME = 'appium-app';

async function retrieveHeaders(link) {
  try {
    const response = await (0, _requestPromise.default)({
      url: link,
      method: 'HEAD',
      resolveWithFullResponse: true,
      timeout: 5000
    });
    return response.headers;
  } catch (e) {
    _logger.default.debug(`Cannot send HEAD request to '${link}'. Original error: ${e.message}`);
  }

  return {};
}

function getCachedApplicationPath(link, currentModified) {
  if (!APPLICATIONS_CACHE.has(link) || !currentModified) {
    return null;
  }

  const {
    lastModified,
    fullPath
  } = APPLICATIONS_CACHE.get(link);

  if (lastModified && currentModified.getTime() <= lastModified.getTime()) {
    _logger.default.debug(`Reusing already downloaded application at '${fullPath}'`);

    return fullPath;
  }

  _logger.default.debug(`'Last-Modified' timestamp of '${link}' has been updated. ` + `An updated copy of the application is going to be downloaded.`);

  return null;
}

function verifyAppExtension(app, supportedAppExtensions) {
  if (supportedAppExtensions.includes(_path.default.extname(app))) {
    return app;
  }

  throw new Error(`New app path '${app}' did not have extension(s) '${supportedAppExtensions}'`);
}

async function configureApp(app, supportedAppExtensions) {
  if (!_lodash.default.isString(app)) {
    return;
  }

  if (!_lodash.default.isArray(supportedAppExtensions)) {
    supportedAppExtensions = [supportedAppExtensions];
  }

  let newApp = app;
  let shouldUnzipApp = false;
  let archiveHash = null;
  let currentModified = null;

  const {
    protocol,
    pathname
  } = _url.default.parse(newApp);

  const isUrl = ['http:', 'https:'].includes(protocol);
  return await APPLICATIONS_CACHE_GUARD.acquire(app, async () => {
    if (isUrl) {
      _logger.default.info(`Using downloadable app '${newApp}'`);

      const headers = await retrieveHeaders(newApp);

      if (headers['last-modified']) {
        _logger.default.debug(`Last-Modified: ${headers['last-modified']}`);

        currentModified = new Date(headers['last-modified']);
      }

      const cachedPath = getCachedApplicationPath(app, currentModified);

      if (cachedPath) {
        if (await _appiumSupport.fs.exists(cachedPath)) {
          _logger.default.info(`Reusing the previously downloaded application at '${cachedPath}'`);

          return verifyAppExtension(cachedPath, supportedAppExtensions);
        }

        _logger.default.info(`The application at '${cachedPath}' does not exist anymore. Deleting it from the cache`);

        APPLICATIONS_CACHE.del(app);
      }

      let fileName = null;
      const basename = (0, _sanitizeFilename.default)(_path.default.basename(decodeURIComponent(pathname)), {
        replacement: SANITIZE_REPLACEMENT
      });

      const extname = _path.default.extname(basename);

      if (ZIP_EXTS.includes(extname)) {
        fileName = basename;
        shouldUnzipApp = true;
      }

      if (headers['content-type']) {
        _logger.default.debug(`Content-Type: ${headers['content-type']}`);

        if (ZIP_MIME_TYPES.some(mimeType => new RegExp(`\\b${_lodash.default.escapeRegExp(mimeType)}\\b`).test(headers['content-type']))) {
          if (!fileName) {
            fileName = `${DEFAULT_BASENAME}.zip`;
          }

          shouldUnzipApp = true;
        }
      }

      if (headers['content-disposition'] && /^attachment/i.test(headers['content-disposition'])) {
        _logger.default.debug(`Content-Disposition: ${headers['content-disposition']}`);

        const match = /filename="([^"]+)/i.exec(headers['content-disposition']);

        if (match) {
          fileName = (0, _sanitizeFilename.default)(match[1], {
            replacement: SANITIZE_REPLACEMENT
          });
          shouldUnzipApp = shouldUnzipApp || ZIP_EXTS.includes(_path.default.extname(fileName));
        }
      }

      if (!fileName) {
        const resultingName = basename ? basename.substring(0, basename.length - extname.length) : DEFAULT_BASENAME;
        let resultingExt = extname;

        if (!supportedAppExtensions.includes(resultingExt)) {
          _logger.default.info(`The current file extension '${resultingExt}' is not supported. ` + `Defaulting to '${_lodash.default.first(supportedAppExtensions)}'`);

          resultingExt = _lodash.default.first(supportedAppExtensions);
        }

        fileName = `${resultingName}${resultingExt}`;
      }

      const targetPath = await _appiumSupport.tempDir.path({
        prefix: fileName,
        suffix: ''
      });
      newApp = await downloadApp(newApp, targetPath);
    } else if (await _appiumSupport.fs.exists(newApp)) {
      _logger.default.info(`Using local app '${newApp}'`);

      shouldUnzipApp = ZIP_EXTS.includes(_path.default.extname(newApp));
    } else {
      let errorMessage = `The application at '${newApp}' does not exist or is not accessible`;

      if (_lodash.default.isString(protocol) && protocol.length > 2) {
        errorMessage = `The protocol '${protocol}' used in '${newApp}' is not supported. ` + `Only http: and https: protocols are supported`;
      }

      throw new Error(errorMessage);
    }

    if (shouldUnzipApp) {
      const archivePath = newApp;
      archiveHash = await _appiumSupport.fs.hash(archivePath);

      if (APPLICATIONS_CACHE.has(app) && archiveHash === APPLICATIONS_CACHE.get(app).hash) {
        const {
          fullPath
        } = APPLICATIONS_CACHE.get(app);

        if (await _appiumSupport.fs.exists(fullPath)) {
          if (archivePath !== app) {
            await _appiumSupport.fs.rimraf(archivePath);
          }

          _logger.default.info(`Will reuse previously cached application at '${fullPath}'`);

          return verifyAppExtension(fullPath, supportedAppExtensions);
        }

        _logger.default.info(`The application at '${fullPath}' does not exist anymore. Deleting it from the cache`);

        APPLICATIONS_CACHE.del(app);
      }

      const tmpRoot = await _appiumSupport.tempDir.openDir();

      try {
        newApp = await unzipApp(archivePath, tmpRoot, supportedAppExtensions);
      } finally {
        if (newApp !== archivePath && archivePath !== app) {
          await _appiumSupport.fs.rimraf(archivePath);
        }
      }

      _logger.default.info(`Unzipped local app to '${newApp}'`);
    } else if (!_path.default.isAbsolute(newApp)) {
      newApp = _path.default.resolve(process.cwd(), newApp);

      _logger.default.warn(`The current application path '${app}' is not absolute ` + `and has been rewritten to '${newApp}'. Consider using absolute paths rather than relative`);

      app = newApp;
    }

    verifyAppExtension(newApp, supportedAppExtensions);

    if (app !== newApp && (archiveHash || currentModified)) {
      APPLICATIONS_CACHE.set(app, {
        hash: archiveHash,
        lastModified: currentModified,
        fullPath: newApp
      });
    }

    return newApp;
  });
}

async function downloadApp(app, targetPath) {
  const {
    href
  } = _url.default.parse(app);

  const started = process.hrtime();

  try {
    await new _bluebird.default((resolve, reject) => {
      (0, _request.default)(href).on('error', reject).on('response', res => {
        if (res.statusCode >= 400) {
          return reject(new Error(`${res.statusCode} - ${res.statusMessage}`));
        }
      }).pipe(_fs2.default.createWriteStream(targetPath)).on('close', resolve);
    });
  } catch (err) {
    throw new Error(`Problem downloading app from url ${href}: ${err.message}`);
  }

  const [seconds, ns] = process.hrtime(started);
  const secondsElapsed = seconds + ns / 1e09;
  const {
    size
  } = await _appiumSupport.fs.stat(targetPath);

  _logger.default.debug(`'${href}' (${_appiumSupport.util.toReadableSizeString(size)}) ` + `has been downloaded to '${targetPath}' in ${secondsElapsed.toFixed(3)}s`);

  if (secondsElapsed >= 2) {
    const bytesPerSec = Math.floor(size / secondsElapsed);

    _logger.default.debug(`Approximate download speed: ${_appiumSupport.util.toReadableSizeString(bytesPerSec)}/s`);
  }

  return targetPath;
}

async function walkDir(dir) {
  const result = [];

  for (const name of await _appiumSupport.fs.readdir(dir)) {
    const currentPath = _path.default.join(dir, name);

    result.push(currentPath);

    if ((await _appiumSupport.fs.stat(currentPath)).isDirectory()) {
      result.push(...(await walkDir(currentPath)));
    }
  }

  return result;
}

async function unzipApp(zipPath, dstRoot, supportedAppExtensions) {
  await _appiumSupport.zip.assertValidZip(zipPath);

  if (!_lodash.default.isArray(supportedAppExtensions)) {
    supportedAppExtensions = [supportedAppExtensions];
  }

  const tmpRoot = await _appiumSupport.tempDir.openDir();

  try {
    _logger.default.debug(`Unzipping '${zipPath}'`);

    await _appiumSupport.zip.extractAllTo(zipPath, tmpRoot);
    const allExtractedItems = await walkDir(tmpRoot);

    _logger.default.debug(`Extracted ${allExtractedItems.length} item(s) from '${zipPath}'`);

    const isSupportedAppItem = relativePath => supportedAppExtensions.includes(_path.default.extname(relativePath)) || _lodash.default.some(supportedAppExtensions, x => relativePath.includes(`${x}${_path.default.sep}`));

    const itemsToKeep = allExtractedItems.map(itemPath => _path.default.relative(tmpRoot, itemPath)).filter(relativePath => isSupportedAppItem(relativePath)).map(relativePath => _path.default.resolve(tmpRoot, relativePath));

    const itemsToRemove = _lodash.default.difference(allExtractedItems, itemsToKeep).filter(itemToRemovePath => !_lodash.default.some(itemsToKeep, itemToKeepPath => itemToKeepPath.startsWith(itemToRemovePath)));

    await _bluebird.default.all(itemsToRemove, async itemPath => {
      if (await _appiumSupport.fs.exists(itemPath)) {
        await _appiumSupport.fs.rimraf(itemPath);
      }
    });
    const allBundleItems = (await walkDir(tmpRoot)).map(itemPath => _path.default.relative(tmpRoot, itemPath)).filter(relativePath => isSupportedAppItem(relativePath)).sort((a, b) => a.split(_path.default.sep).length - b.split(_path.default.sep).length);

    if (_lodash.default.isEmpty(allBundleItems)) {
      throw new Error(`App zip unzipped OK, but we could not find ${supportedAppExtensions} bundle(s) ` + `in it. Make sure your archive contains ${supportedAppExtensions} package(s) ` + `and nothing else`);
    }

    const matchedBundle = _lodash.default.first(allBundleItems);

    _logger.default.debug(`Matched ${allBundleItems.length} item(s) in the extracted archive. ` + `Assuming '${matchedBundle}' is the correct bundle`);

    await _appiumSupport.fs.mv(_path.default.resolve(tmpRoot, matchedBundle), _path.default.resolve(dstRoot, matchedBundle), {
      mkdirp: true
    });
    return _path.default.resolve(dstRoot, matchedBundle);
  } finally {
    await _appiumSupport.fs.rimraf(tmpRoot);
  }
}

function isPackageOrBundle(app) {
  return /^([a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+)+$/.test(app);
}

function getCoordDefault(val) {
  return _appiumSupport.util.hasValue(val) ? val : 0.5;
}

function getSwipeTouchDuration(waitGesture) {
  let duration = 0.8;

  if (typeof waitGesture.options.ms !== 'undefined' && waitGesture.options.ms) {
    duration = waitGesture.options.ms / 1000;

    if (duration === 0) {
      duration = 0.1;
    }
  }

  return duration;
}

function duplicateKeys(input, firstKey, secondKey) {
  if (_lodash.default.isArray(input)) {
    return input.map(item => duplicateKeys(item, firstKey, secondKey));
  }

  if (_lodash.default.isPlainObject(input)) {
    const resultObj = {};

    for (let [key, value] of _lodash.default.toPairs(input)) {
      const recursivelyCalledValue = duplicateKeys(value, firstKey, secondKey);

      if (key === firstKey) {
        resultObj[secondKey] = recursivelyCalledValue;
      } else if (key === secondKey) {
        resultObj[firstKey] = recursivelyCalledValue;
      }

      resultObj[key] = recursivelyCalledValue;
    }

    return resultObj;
  }

  return input;
}

function parseCapsArray(cap) {
  let parsedCaps;

  try {
    parsedCaps = JSON.parse(cap);

    if (_lodash.default.isArray(parsedCaps)) {
      return parsedCaps;
    }
  } catch (ign) {
    _logger.default.warn(`Failed to parse capability as JSON array`);
  }

  if (_lodash.default.isString(cap)) {
    return [cap];
  }

  throw new Error(`must provide a string or JSON Array; received ${cap}`);
}require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImxpYi9iYXNlZHJpdmVyL2hlbHBlcnMuanMiXSwibmFtZXMiOlsiWklQX0VYVFMiLCJaSVBfTUlNRV9UWVBFUyIsIkFQUExJQ0FUSU9OU19DQUNIRSIsIkxSVSIsIm1heCIsIkFQUExJQ0FUSU9OU19DQUNIRV9HVUFSRCIsIkFzeW5jTG9jayIsIlNBTklUSVpFX1JFUExBQ0VNRU5UIiwiREVGQVVMVF9CQVNFTkFNRSIsInJldHJpZXZlSGVhZGVycyIsImxpbmsiLCJyZXNwb25zZSIsInVybCIsIm1ldGhvZCIsInJlc29sdmVXaXRoRnVsbFJlc3BvbnNlIiwidGltZW91dCIsImhlYWRlcnMiLCJlIiwibG9nZ2VyIiwiZGVidWciLCJtZXNzYWdlIiwiZ2V0Q2FjaGVkQXBwbGljYXRpb25QYXRoIiwiY3VycmVudE1vZGlmaWVkIiwiaGFzIiwibGFzdE1vZGlmaWVkIiwiZnVsbFBhdGgiLCJnZXQiLCJnZXRUaW1lIiwidmVyaWZ5QXBwRXh0ZW5zaW9uIiwiYXBwIiwic3VwcG9ydGVkQXBwRXh0ZW5zaW9ucyIsImluY2x1ZGVzIiwicGF0aCIsImV4dG5hbWUiLCJFcnJvciIsImNvbmZpZ3VyZUFwcCIsIl8iLCJpc1N0cmluZyIsImlzQXJyYXkiLCJuZXdBcHAiLCJzaG91bGRVbnppcEFwcCIsImFyY2hpdmVIYXNoIiwicHJvdG9jb2wiLCJwYXRobmFtZSIsInBhcnNlIiwiaXNVcmwiLCJhY3F1aXJlIiwiaW5mbyIsIkRhdGUiLCJjYWNoZWRQYXRoIiwiZnMiLCJleGlzdHMiLCJkZWwiLCJmaWxlTmFtZSIsImJhc2VuYW1lIiwiZGVjb2RlVVJJQ29tcG9uZW50IiwicmVwbGFjZW1lbnQiLCJzb21lIiwibWltZVR5cGUiLCJSZWdFeHAiLCJlc2NhcGVSZWdFeHAiLCJ0ZXN0IiwibWF0Y2giLCJleGVjIiwicmVzdWx0aW5nTmFtZSIsInN1YnN0cmluZyIsImxlbmd0aCIsInJlc3VsdGluZ0V4dCIsImZpcnN0IiwidGFyZ2V0UGF0aCIsInRlbXBEaXIiLCJwcmVmaXgiLCJzdWZmaXgiLCJkb3dubG9hZEFwcCIsImVycm9yTWVzc2FnZSIsImFyY2hpdmVQYXRoIiwiaGFzaCIsInJpbXJhZiIsInRtcFJvb3QiLCJvcGVuRGlyIiwidW56aXBBcHAiLCJpc0Fic29sdXRlIiwicmVzb2x2ZSIsInByb2Nlc3MiLCJjd2QiLCJ3YXJuIiwic2V0IiwiaHJlZiIsInN0YXJ0ZWQiLCJocnRpbWUiLCJCIiwicmVqZWN0Iiwib24iLCJyZXMiLCJzdGF0dXNDb2RlIiwic3RhdHVzTWVzc2FnZSIsInBpcGUiLCJfZnMiLCJjcmVhdGVXcml0ZVN0cmVhbSIsImVyciIsInNlY29uZHMiLCJucyIsInNlY29uZHNFbGFwc2VkIiwic2l6ZSIsInN0YXQiLCJ1dGlsIiwidG9SZWFkYWJsZVNpemVTdHJpbmciLCJ0b0ZpeGVkIiwiYnl0ZXNQZXJTZWMiLCJNYXRoIiwiZmxvb3IiLCJ3YWxrRGlyIiwiZGlyIiwicmVzdWx0IiwibmFtZSIsInJlYWRkaXIiLCJjdXJyZW50UGF0aCIsImpvaW4iLCJwdXNoIiwiaXNEaXJlY3RvcnkiLCJ6aXBQYXRoIiwiZHN0Um9vdCIsInppcCIsImFzc2VydFZhbGlkWmlwIiwiZXh0cmFjdEFsbFRvIiwiYWxsRXh0cmFjdGVkSXRlbXMiLCJpc1N1cHBvcnRlZEFwcEl0ZW0iLCJyZWxhdGl2ZVBhdGgiLCJ4Iiwic2VwIiwiaXRlbXNUb0tlZXAiLCJtYXAiLCJpdGVtUGF0aCIsInJlbGF0aXZlIiwiZmlsdGVyIiwiaXRlbXNUb1JlbW92ZSIsImRpZmZlcmVuY2UiLCJpdGVtVG9SZW1vdmVQYXRoIiwiaXRlbVRvS2VlcFBhdGgiLCJzdGFydHNXaXRoIiwiYWxsIiwiYWxsQnVuZGxlSXRlbXMiLCJzb3J0IiwiYSIsImIiLCJzcGxpdCIsImlzRW1wdHkiLCJtYXRjaGVkQnVuZGxlIiwibXYiLCJta2RpcnAiLCJpc1BhY2thZ2VPckJ1bmRsZSIsImdldENvb3JkRGVmYXVsdCIsInZhbCIsImhhc1ZhbHVlIiwiZ2V0U3dpcGVUb3VjaER1cmF0aW9uIiwid2FpdEdlc3R1cmUiLCJkdXJhdGlvbiIsIm9wdGlvbnMiLCJtcyIsImR1cGxpY2F0ZUtleXMiLCJpbnB1dCIsImZpcnN0S2V5Iiwic2Vjb25kS2V5IiwiaXRlbSIsImlzUGxhaW5PYmplY3QiLCJyZXN1bHRPYmoiLCJrZXkiLCJ2YWx1ZSIsInRvUGFpcnMiLCJyZWN1cnNpdmVseUNhbGxlZFZhbHVlIiwicGFyc2VDYXBzQXJyYXkiLCJjYXAiLCJwYXJzZWRDYXBzIiwiSlNPTiIsImlnbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7OztBQUFBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUVBLE1BQU1BLFFBQVEsR0FBRyxDQUFDLE1BQUQsRUFBUyxNQUFULENBQWpCO0FBQ0EsTUFBTUMsY0FBYyxHQUFHLENBQ3JCLGlCQURxQixFQUVyQiw4QkFGcUIsRUFHckIsaUJBSHFCLENBQXZCO0FBS0EsTUFBTUMsa0JBQWtCLEdBQUcsSUFBSUMsaUJBQUosQ0FBUTtBQUNqQ0MsRUFBQUEsR0FBRyxFQUFFO0FBRDRCLENBQVIsQ0FBM0I7QUFHQSxNQUFNQyx3QkFBd0IsR0FBRyxJQUFJQyxrQkFBSixFQUFqQztBQUNBLE1BQU1DLG9CQUFvQixHQUFHLEdBQTdCO0FBQ0EsTUFBTUMsZ0JBQWdCLEdBQUcsWUFBekI7O0FBRUEsZUFBZUMsZUFBZixDQUFnQ0MsSUFBaEMsRUFBc0M7QUFDcEMsTUFBSTtBQUNGLFVBQU1DLFFBQVEsR0FBRyxNQUFNLDZCQUFhO0FBQ2xDQyxNQUFBQSxHQUFHLEVBQUVGLElBRDZCO0FBRWxDRyxNQUFBQSxNQUFNLEVBQUUsTUFGMEI7QUFHbENDLE1BQUFBLHVCQUF1QixFQUFFLElBSFM7QUFJbENDLE1BQUFBLE9BQU8sRUFBRTtBQUp5QixLQUFiLENBQXZCO0FBTUEsV0FBT0osUUFBUSxDQUFDSyxPQUFoQjtBQUNELEdBUkQsQ0FRRSxPQUFPQyxDQUFQLEVBQVU7QUFDVkMsb0JBQU9DLEtBQVAsQ0FBYyxnQ0FBK0JULElB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QUFULENBQXlCQyxHQUF6QixFQUE4QjtBQUM1QixNQUFJQyxVQUFKOztBQUNBLE1BQUk7QUFDRkEsSUFBQUEsVUFBVSxHQUFHQyxJQUFJLENBQUNqSSxLQUFMLENBQVcrSCxHQUFYLENBQWI7O0FBQ0EsUUFBSXZJLGdCQUFFRSxPQUFGLENBQVVzSSxVQUFWLENBQUosRUFBMkI7QUFDekIsYUFBT0EsVUFBUDtBQUNEO0FBQ0YsR0FMRCxDQUtFLE9BQU9FLEdBQVAsRUFBWTtBQUNaNUosb0JBQU9tRSxJQUFQLENBQWEsMENBQWI7QUFDRDs7QUFDRCxNQUFJakQsZ0JBQUVDLFFBQUYsQ0FBV3NJLEdBQVgsQ0FBSixFQUFxQjtBQUNuQixXQUFPLENBQUNBLEdBQUQsQ0FBUDtBQUNEOztBQUNELFFBQU0sSUFBSXpJLEtBQUosQ0FBVyxpREFBZ0R5SSxHQUFJLEVBQS9ELENBQU47QUFDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB1cmwgZnJvbSAndXJsJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IF9mcyBmcm9tICdmcyc7XG5pbXBvcnQgQiBmcm9tICdibHVlYmlyZCc7XG5pbXBvcnQgeyB0ZW1wRGlyLCBmcywgdXRpbCwgemlwIH0gZnJvbSAnYXBwaXVtLXN1cHBvcnQnO1xuaW1wb3J0IHJlcXVlc3QgZnJvbSAncmVxdWVzdCc7XG5pbXBvcnQgYXN5bmNSZXF1ZXN0IGZyb20gJ3JlcXVlc3QtcHJvbWlzZSc7XG5pbXBvcnQgTFJVIGZyb20gJ2xydS1jYWNoZSc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0IHNhbml0aXplIGZyb20gJ3Nhbml0aXplLWZpbGVuYW1lJztcblxuY29uc3QgWklQX0VYVFMgPSBbJy56aXAnLCAnLmlwYSddO1xuY29uc3QgWklQX01JTUVfVFlQRVMgPSBbXG4gICdhcHBsaWNhdGlvbi96aXAnLFxuICAnYXBwbGljYXRpb24veC16aXAtY29tcHJlc3NlZCcsXG4gICdtdWx0aXBhcnQveC16aXAnLFxuXTtcbmNvbnN0IEFQUExJQ0FUSU9OU19DQUNIRSA9IG5ldyBMUlUoe1xuICBtYXg6IDEwMCxcbn0pO1xuY29uc3QgQVBQTElDQVRJT05TX0NBQ0hFX0dVQVJEID0gbmV3IEFzeW5jTG9jaygpO1xuY29uc3QgU0FOSVRJWkVfUkVQTEFDRU1FTlQgPSAnLSc7XG5jb25zdCBERUZBVUxUX0JBU0VOQU1FID0gJ2FwcGl1bS1hcHAnO1xuXG5hc3luYyBmdW5jdGlvbiByZXRyaWV2ZUhlYWRlcnMgKGxpbmspIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGFzeW5jUmVxdWVzdCh7XG4gICAgICB1cmw6IGxpbmssXG4gICAgICBtZXRob2Q6ICdIRUFEJyxcbiAgICAgIHJlc29sdmVXaXRoRnVsbFJlc3BvbnNlOiB0cnVlLFxuICAgICAgdGltZW91dDogNTAwMCxcbiAgICB9KTtcbiAgICByZXR1cm4gcmVzcG9uc2UuaGVhZGVycztcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ2dlci5kZWJ1ZyhgQ2Fubm90IHNlbmQgSEVBRCByZXF1ZXN0IHRvICcke2xpbmt9Jy4gT3JpZ2luYWwgZXJyb3I6ICR7ZS5tZXNzYWdlfWApO1xuICB9XG4gIHJldHVybiB7fTtcbn1cblxuZnVuY3Rpb24gZ2V0Q2FjaGVkQXBwbGljYXRpb25QYXRoIChsaW5rLCBjdXJyZW50TW9kaWZpZWQpIHtcbiAgaWYgKCFBUFBMSUNBVElPTlNfQ0FDSEUuaGFzKGxpbmspIHx8ICFjdXJyZW50TW9kaWZpZWQpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IHtsYXN0TW9kaWZpZWQsIGZ1bGxQYXRofSA9IEFQUExJQ0FUSU9OU19DQUNIRS5nZXQobGluayk7XG4gIGlmIChsYXN0TW9kaWZpZWQgJiYgY3VycmVudE1vZGlmaWVkLmdldFRpbWUoKSA8PSBsYXN0TW9kaWZpZWQuZ2V0VGltZSgpKSB7XG4gICAgbG9nZ2VyLmRlYnVnKGBSZXVzaW5nIGFscmVhZHkgZG93bmxvYWRlZCBhcHBsaWNhdGlvbiBhdCAnJHtmdWxsUGF0aH0nYCk7XG4gICAgcmV0dXJuIGZ1bGxQYXRoO1xuICB9XG4gIGxvZ2dlci5kZWJ1ZyhgJ0xhc3QtTW9kaWZpZWQnIHRpbWVzdGFtcCBvZiAnJHtsaW5rfScgaGFzIGJlZW4gdXBkYXRlZC4gYCArXG4gICAgYEFuIHVwZGF0ZWQgY29weSBvZiB0aGUgYXBwbGljYXRpb24gaXMgZ29pbmcgdG8gYmUgZG93bmxvYWRlZC5gKTtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHZlcmlmeUFwcEV4dGVuc2lvbiAoYXBwLCBzdXBwb3J0ZWRBcHBFeHRlbnNpb25zKSB7XG4gIGlmIChzdXBwb3J0ZWRBcHBFeHRlbnNpb25zLmluY2x1ZGVzKHBhdGguZXh0bmFtZShhcHApKSkge1xuICAgIHJldHVybiBhcHA7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKGBOZXcgYXBwIHBhdGggJyR7YXBwfScgZGlkIG5vdCBoYXZlIGV4dGVuc2lvbihzKSAnJHtzdXBwb3J0ZWRBcHBFeHRlbnNpb25zfSdgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlQXBwIChhcHAsIHN1cHBvcnRlZEFwcEV4dGVuc2lvbnMpIHtcbiAgaWYgKCFfLmlzU3RyaW5nKGFwcCkpIHtcbiAgICAvLyBpbW1lZGlhdGVseSBzaG9ydGNpcmN1aXQgaWYgbm90IGdpdmVuIGFuIGFwcFxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIV8uaXNBcnJheShzdXBwb3J0ZWRBcHBFeHRlbnNpb25zKSkge1xuICAgIHN1cHBvcnRlZEFwcEV4dGVuc2lvbnMgPSBbc3VwcG9ydGVkQXBwRXh0ZW5zaW9uc107XG4gIH1cblxuICBsZXQgbmV3QXBwID0gYXBwO1xuICBsZXQgc2hvdWxkVW56aXBBcHAgPSBmYWxzZTtcbiAgbGV0IGFyY2hpdmVIYXNoID0gbnVsbDtcbiAgbGV0IGN1cnJlbnRNb2RpZmllZCA9IG51bGw7XG4gIGNvbnN0IHtwcm90b2NvbCwgcGF0aG5hbWV9ID0gdXJsLnBhcnNlKG5ld0FwcCk7XG4gIGNvbnN0IGlzVXJsID0gWydodHRwOicsICdodHRwczonXS5pbmNsdWRlcyhwcm90b2NvbCk7XG5cbiAgcmV0dXJuIGF3YWl0IEFQUExJQ0FUSU9OU19DQUNIRV9HVUFSRC5hY3F1aXJlKGFwcCwgYXN5bmMgKCkgPT4ge1xuICAgIGlmIChpc1VybCkge1xuICAgICAgLy8gVXNlIHRoZSBhcHAgZnJvbSByZW1vdGUgVVJMXG4gICAgICBsb2dnZXIuaW5mbyhgVXNpbmcgZG93bmxvYWRhYmxlIGFwcCAnJHtuZXdBcHB9J2ApO1xuICAgICAgY29uc3QgaGVhZGVycyA9IGF3YWl0IHJldHJpZXZlSGVhZGVycyhuZXdBcHApO1xuICAgICAgaWYgKGhlYWRlcnNbJ2xhc3QtbW9kaWZpZWQnXSkge1xuICAgICAgICBsb2dnZXIuZGVidWcoYExhc3QtTW9kaWZpZWQ6ICR7aGVhZGVyc1snbGFzdC1tb2RpZmllZCddfWApO1xuICAgICAgICBjdXJyZW50TW9kaWZpZWQgPSBuZXcgRGF0ZShoZWFkZXJzWydsYXN0LW1vZGlmaWVkJ10pO1xuICAgICAgfVxuICAgICAgY29uc3QgY2FjaGVkUGF0aCA9IGdldENhY2hlZEFwcGxpY2F0aW9uUGF0aChhcHAsIGN1cnJlbnRNb2RpZmllZCk7XG4gICAgICBpZiAoY2FjaGVkUGF0aCkge1xuICAgICAgICBpZiAoYXdhaXQgZnMuZXhpc3RzKGNhY2hlZFBhdGgpKSB7XG4gICAgICAgICAgbG9nZ2VyLmluZm8oYFJldXNpbmcgdGhlIHByZXZpb3VzbHkgZG93bmxvYWRlZCBhcHBsaWNhdGlvbiBhdCAnJHtjYWNoZWRQYXRofSdgKTtcbiAgICAgICAgICByZXR1cm4gdmVyaWZ5QXBwRXh0ZW5zaW9uKGNhY2hlZFBhdGgsIHN1cHBvcnRlZEFwcEV4dGVuc2lvbnMpO1xuICAgICAgICB9XG4gICAgICAgIGxvZ2dlci5pbmZvKGBUaGUgYXBwbGljYXRpb24gYXQgJyR7Y2FjaGVkUGF0aH0nIGRvZXMgbm90IGV4aXN0IGFueW1vcmUuIERlbGV0aW5nIGl0IGZyb20gdGhlIGNhY2hlYCk7XG4gICAgICAgIEFQUExJQ0FUSU9OU19DQUNIRS5kZWwoYXBwKTtcbiAgICAgIH1cblxuICAgICAgbGV0IGZpbGVOYW1lID0gbnVsbDtcbiAgICAgIGNvbnN0IGJhc2VuYW1lID0gc2FuaXRpemUocGF0aC5iYXNlbmFtZShkZWNvZGVVUklDb21wb25lbnQocGF0aG5hbWUpKSwge1xuICAgICAgICByZXBsYWNlbWVudDogU0FOSVRJWkVfUkVQTEFDRU1FTlRcbiAgICAgIH0pO1xuICAgICAgY29uc3QgZXh0bmFtZSA9IHBhdGguZXh0bmFtZShiYXNlbmFtZSk7XG4gICAgICAvLyB0byBkZXRlcm1pbmUgaWYgd2UgbmVlZCB0byB1bnppcCB0aGUgYXBwLCB3ZSBoYXZlIGEgbnVtYmVyIG9mIHBsYWNlc1xuICAgICAgLy8gdG8gbG9vazogY29udGVudCB0eXBlLCBjb250ZW50IGRpc3Bvc2l0aW9uLCBvciB0aGUgZmlsZSBleHRlbnNpb25cbiAgICAgIGlmIChaSVBfRVhUUy5pbmNsdWRlcyhleHRuYW1lKSkge1xuICAgICAgICBmaWxlTmFtZSA9IGJhc2VuYW1lO1xuICAgICAgICBzaG91bGRVbnppcEFwcCA9IHRydWU7XG4gICAgICB9XG4gICAgICBpZiAoaGVhZGVyc1snY29udGVudC10eXBlJ10pIHtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKGBDb250ZW50LVR5cGU6ICR7aGVhZGVyc1snY29udGVudC10eXBlJ119YCk7XG4gICAgICAgIC8vIHRoZSBmaWxldHlwZSBtYXkgbm90IGJlIG9idmlvdXMgZm9yIGNlcnRhaW4gdXJscywgc28gY2hlY2sgdGhlIG1pbWUgdHlwZSB0b29cbiAgICAgICAgaWYgKFpJUF9NSU1FX1RZUEVTLnNvbWUobWltZVR5cGUgPT4gbmV3IFJlZ0V4cChgXFxcXGIke18uZXNjYXBlUmVnRXhwKG1pbWVUeXBlKX1cXFxcYmApLnRlc3QoaGVhZGVyc1snY29udGVudC10eXBlJ10pKSkge1xuICAgICAgICAgIGlmICghZmlsZU5hbWUpIHtcbiAgICAgICAgICAgIGZpbGVOYW1lID0gYCR7REVGQVVMVF9CQVNFTkFNRX0uemlwYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgc2hvdWxkVW56aXBBcHAgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoaGVhZGVyc1snY29udGVudC1kaXNwb3NpdGlvbiddICYmIC9eYXR0YWNobWVudC9pLnRlc3QoaGVhZGVyc1snY29udGVudC1kaXNwb3NpdGlvbiddKSkge1xuICAgICAgICBsb2dnZXIuZGVidWcoYENvbnRlbnQtRGlzcG9zaXRpb246ICR7aGVhZGVyc1snY29udGVudC1kaXNwb3NpdGlvbiddfWApO1xuICAgICAgICBjb25zdCBtYXRjaCA9IC9maWxlbmFtZT1cIihbXlwiXSspL2kuZXhlYyhoZWFkZXJzWydjb250ZW50LWRpc3Bvc2l0aW9uJ10pO1xuICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICBmaWxlTmFtZSA9IHNhbml0aXplKG1hdGNoWzFdLCB7XG4gICAgICAgICAgICByZXBsYWNlbWVudDogU0FOSVRJWkVfUkVQTEFDRU1FTlRcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBzaG91bGRVbnppcEFwcCA9IHNob3VsZFVuemlwQXBwIHx8IFpJUF9FWFRTLmluY2x1ZGVzKHBhdGguZXh0bmFtZShmaWxlTmFtZSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoIWZpbGVOYW1lKSB7XG4gICAgICAgIC8vIGFzc2lnbiB0aGUgZGVmYXVsdCBmaWxlIG5hbWUgYW5kIHRoZSBleHRlbnNpb24gaWYgbm9uZSBoYXMgYmVlbiBkZXRlY3RlZFxuICAgICAgICBjb25zdCByZXN1bHRpbmdOYW1lID0gYmFzZW5hbWVcbiAgICAgICAgICA/IGJhc2VuYW1lLnN1YnN0cmluZygwLCBiYXNlbmFtZS5sZW5ndGggLSBleHRuYW1lLmxlbmd0aClcbiAgICAgICAgICA6IERFRkFVTFRfQkFTRU5BTUU7XG4gICAgICAgIGxldCByZXN1bHRpbmdFeHQgPSBleHRuYW1lO1xuICAgICAgICBpZiAoIXN1cHBvcnRlZEFwcEV4dGVuc2lvbnMuaW5jbHVkZXMocmVzdWx0aW5nRXh0KSkge1xuICAgICAgICAgIGxvZ2dlci5pbmZvKGBUaGUgY3VycmVudCBmaWxlIGV4dGVuc2lvbiAnJHtyZXN1bHRpbmdFeHR9JyBpcyBub3Qgc3VwcG9ydGVkLiBgICtcbiAgICAgICAgICAgIGBEZWZhdWx0aW5nIHRvICcke18uZmlyc3Qoc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucyl9J2ApO1xuICAgICAgICAgIHJlc3VsdGluZ0V4dCA9IF8uZmlyc3Qoc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucyk7XG4gICAgICAgIH1cbiAgICAgICAgZmlsZU5hbWUgPSBgJHtyZXN1bHRpbmdOYW1lfSR7cmVzdWx0aW5nRXh0fWA7XG4gICAgICB9XG4gICAgICBjb25zdCB0YXJnZXRQYXRoID0gYXdhaXQgdGVtcERpci5wYXRoKHtcbiAgICAgICAgcHJlZml4OiBmaWxlTmFtZSxcbiAgICAgICAgc3VmZml4OiAnJyxcbiAgICAgIH0pO1xuICAgICAgbmV3QXBwID0gYXdhaXQgZG93bmxvYWRBcHAobmV3QXBwLCB0YXJnZXRQYXRoKTtcbiAgICB9IGVsc2UgaWYgKGF3YWl0IGZzLmV4aXN0cyhuZXdBcHApKSB7XG4gICAgICAvLyBVc2UgdGhlIGxvY2FsIGFwcFxuICAgICAgbG9nZ2VyLmluZm8oYFVzaW5nIGxvY2FsIGFwcCAnJHtuZXdBcHB9J2ApO1xuICAgICAgc2hvdWxkVW56aXBBcHAgPSBaSVBfRVhUUy5pbmNsdWRlcyhwYXRoLmV4dG5hbWUobmV3QXBwKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxldCBlcnJvck1lc3NhZ2UgPSBgVGhlIGFwcGxpY2F0aW9uIGF0ICcke25ld0FwcH0nIGRvZXMgbm90IGV4aXN0IG9yIGlzIG5vdCBhY2Nlc3NpYmxlYDtcbiAgICAgIC8vIHByb3RvY29sIHZhbHVlIGZvciAnQzpcXFxcdGVtcCcgaXMgJ2M6Jywgc28gd2UgY2hlY2sgdGhlIGxlbmd0aCBhcyB3ZWxsXG4gICAgICBpZiAoXy5pc1N0cmluZyhwcm90b2NvbCkgJiYgcHJvdG9jb2wubGVuZ3RoID4gMikge1xuICAgICAgICBlcnJvck1lc3NhZ2UgPSBgVGhlIHByb3RvY29sICcke3Byb3RvY29sfScgdXNlZCBpbiAnJHtuZXdBcHB9JyBpcyBub3Qgc3VwcG9ydGVkLiBgICtcbiAgICAgICAgICBgT25seSBodHRwOiBhbmQgaHR0cHM6IHByb3RvY29scyBhcmUgc3VwcG9ydGVkYDtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIH1cblxuICAgIGlmIChzaG91bGRVbnppcEFwcCkge1xuICAgICAgY29uc3QgYXJjaGl2ZVBhdGggPSBuZXdBcHA7XG4gICAgICBhcmNoaXZlSGFzaCA9IGF3YWl0IGZzLmhhc2goYXJjaGl2ZVBhdGgpO1xuICAgICAgaWYgKEFQUExJQ0FUSU9OU19DQUNIRS5oYXMoYXBwKSAmJiBhcmNoaXZlSGFzaCA9PT0gQVBQTElDQVRJT05TX0NBQ0hFLmdldChhcHApLmhhc2gpIHtcbiAgICAgICAgY29uc3Qge2Z1bGxQYXRofSA9IEFQUExJQ0FUSU9OU19DQUNIRS5nZXQoYXBwKTtcbiAgICAgICAgaWYgKGF3YWl0IGZzLmV4aXN0cyhmdWxsUGF0aCkpIHtcbiAgICAgICAgICBpZiAoYXJjaGl2ZVBhdGggIT09IGFwcCkge1xuICAgICAgICAgICAgYXdhaXQgZnMucmltcmFmKGFyY2hpdmVQYXRoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgbG9nZ2VyLmluZm8oYFdpbGwgcmV1c2UgcHJldmlvdXNseSBjYWNoZWQgYXBwbGljYXRpb24gYXQgJyR7ZnVsbFBhdGh9J2ApO1xuICAgICAgICAgIHJldHVybiB2ZXJpZnlBcHBFeHRlbnNpb24oZnVsbFBhdGgsIHN1cHBvcnRlZEFwcEV4dGVuc2lvbnMpO1xuICAgICAgICB9XG4gICAgICAgIGxvZ2dlci5pbmZvKGBUaGUgYXBwbGljYXRpb24gYXQgJyR7ZnVsbFBhdGh9JyBkb2VzIG5vdCBleGlzdCBhbnltb3JlLiBEZWxldGluZyBpdCBmcm9tIHRoZSBjYWNoZWApO1xuICAgICAgICBBUFBMSUNBVElPTlNfQ0FDSEUuZGVsKGFwcCk7XG4gICAgICB9XG4gICAgICBjb25zdCB0bXBSb290ID0gYXdhaXQgdGVtcERpci5vcGVuRGlyKCk7XG4gICAgICB0cnkge1xuICAgICAgICBuZXdBcHAgPSBhd2FpdCB1bnppcEFwcChhcmNoaXZlUGF0aCwgdG1wUm9vdCwgc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAobmV3QXBwICE9PSBhcmNoaXZlUGF0aCAmJiBhcmNoaXZlUGF0aCAhPT0gYXBwKSB7XG4gICAgICAgICAgYXdhaXQgZnMucmltcmFmKGFyY2hpdmVQYXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgbG9nZ2VyLmluZm8oYFVuemlwcGVkIGxvY2FsIGFwcCB0byAnJHtuZXdBcHB9J2ApO1xuICAgIH0gZWxzZSBpZiAoIXBhdGguaXNBYnNvbHV0ZShuZXdBcHApKSB7XG4gICAgICBuZXdBcHAgPSBwYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSwgbmV3QXBwKTtcbiAgICAgIGxvZ2dlci53YXJuKGBUaGUgY3VycmVudCBhcHBsaWNhdGlvbiBwYXRoICcke2FwcH0nIGlzIG5vdCBhYnNvbHV0ZSBgICtcbiAgICAgICAgYGFuZCBoYXMgYmVlbiByZXdyaXR0ZW4gdG8gJyR7bmV3QXBwfScuIENvbnNpZGVyIHVzaW5nIGFic29sdXRlIHBhdGhzIHJhdGhlciB0aGFuIHJlbGF0aXZlYCk7XG4gICAgICBhcHAgPSBuZXdBcHA7XG4gICAgfVxuXG4gICAgdmVyaWZ5QXBwRXh0ZW5zaW9uKG5ld0FwcCwgc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucyk7XG5cbiAgICBpZiAoYXBwICE9PSBuZXdBcHAgJiYgKGFyY2hpdmVIYXNoIHx8IGN1cnJlbnRNb2RpZmllZCkpIHtcbiAgICAgIEFQUExJQ0FUSU9OU19DQUNIRS5zZXQoYXBwLCB7XG4gICAgICAgIGhhc2g6IGFyY2hpdmVIYXNoLFxuICAgICAgICBsYXN0TW9kaWZpZWQ6IGN1cnJlbnRNb2RpZmllZCxcbiAgICAgICAgZnVsbFBhdGg6IG5ld0FwcCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gbmV3QXBwO1xuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZG93bmxvYWRBcHAgKGFwcCwgdGFyZ2V0UGF0aCkge1xuICBjb25zdCB7aHJlZn0gPSB1cmwucGFyc2UoYXBwKTtcbiAgY29uc3Qgc3RhcnRlZCA9IHByb2Nlc3MuaHJ0aW1lKCk7XG4gIHRyeSB7XG4gICAgLy8gZG9uJ3QgdXNlIHJlcXVlc3QtcHJvbWlzZSBoZXJlLCB3ZSBuZWVkIHN0cmVhbXNcbiAgICBhd2FpdCBuZXcgQigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICByZXF1ZXN0KGhyZWYpXG4gICAgICAgIC5vbignZXJyb3InLCByZWplY3QpIC8vIGhhbmRsZSByZWFsIGVycm9ycywgbGlrZSBjb25uZWN0aW9uIGVycm9yc1xuICAgICAgICAub24oJ3Jlc3BvbnNlJywgKHJlcykgPT4ge1xuICAgICAgICAgIC8vIGhhbmRsZSByZXNwb25zZXMgdGhhdCBmYWlsLCBsaWtlIDQwNHNcbiAgICAgICAgICBpZiAocmVzLnN0YXR1c0NvZGUgPj0gNDAwKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcihgJHtyZXMuc3RhdHVzQ29kZX0gLSAke3Jlcy5zdGF0dXNNZXNzYWdlfWApKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICAgIC5waXBlKF9mcy5jcmVhdGVXcml0ZVN0cmVhbSh0YXJnZXRQYXRoKSlcbiAgICAgICAgLm9uKCdjbG9zZScsIHJlc29sdmUpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFByb2JsZW0gZG93bmxvYWRpbmcgYXBwIGZyb20gdXJsICR7aHJlZn06ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gIH1cbiAgY29uc3QgW3NlY29uZHMsIG5zXSA9IHByb2Nlc3MuaHJ0aW1lKHN0YXJ0ZWQpO1xuICBjb25zdCBzZWNvbmRzRWxhcHNlZCA9IHNlY29uZHMgKyBucyAvIDFlMDk7XG4gIGNvbnN0IHtzaXplfSA9IGF3YWl0IGZzLnN0YXQodGFyZ2V0UGF0aCk7XG4gIGxvZ2dlci5kZWJ1ZyhgJyR7aHJlZn0nICgke3V0aWwudG9SZWFkYWJsZVNpemVTdHJpbmcoc2l6ZSl9KSBgICtcbiAgICBgaGFzIGJlZW4gZG93bmxvYWRlZCB0byAnJHt0YXJnZXRQYXRofScgaW4gJHtzZWNvbmRzRWxhcHNlZC50b0ZpeGVkKDMpfXNgKTtcbiAgaWYgKHNlY29uZHNFbGFwc2VkID49IDIpIHtcbiAgICBjb25zdCBieXRlc1BlclNlYyA9IE1hdGguZmxvb3Ioc2l6ZSAvIHNlY29uZHNFbGFwc2VkKTtcbiAgICBsb2dnZXIuZGVidWcoYEFwcHJveGltYXRlIGRvd25sb2FkIHNwZWVkOiAke3V0aWwudG9SZWFkYWJsZVNpemVTdHJpbmcoYnl0ZXNQZXJTZWMpfS9zYCk7XG4gIH1cbiAgcmV0dXJuIHRhcmdldFBhdGg7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdhbGtEaXIgKGRpcikge1xuICBjb25zdCByZXN1bHQgPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIGF3YWl0IGZzLnJlYWRkaXIoZGlyKSkge1xuICAgIGNvbnN0IGN1cnJlbnRQYXRoID0gcGF0aC5qb2luKGRpciwgbmFtZSk7XG4gICAgcmVzdWx0LnB1c2goY3VycmVudFBhdGgpO1xuICAgIGlmICgoYXdhaXQgZnMuc3RhdChjdXJyZW50UGF0aCkpLmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgIHJlc3VsdC5wdXNoKC4uLihhd2FpdCB3YWxrRGlyKGN1cnJlbnRQYXRoKSkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5hc3luYyBmdW5jdGlvbiB1bnppcEFwcCAoemlwUGF0aCwgZHN0Um9vdCwgc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucykge1xuICBhd2FpdCB6aXAuYXNzZXJ0VmFsaWRaaXAoemlwUGF0aCk7XG5cbiAgaWYgKCFfLmlzQXJyYXkoc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucykpIHtcbiAgICBzdXBwb3J0ZWRBcHBFeHRlbnNpb25zID0gW3N1cHBvcnRlZEFwcEV4dGVuc2lvbnNdO1xuICB9XG5cbiAgY29uc3QgdG1wUm9vdCA9IGF3YWl0IHRlbXBEaXIub3BlbkRpcigpO1xuICB0cnkge1xuICAgIGxvZ2dlci5kZWJ1ZyhgVW56aXBwaW5nICcke3ppcFBhdGh9J2ApO1xuICAgIGF3YWl0IHppcC5leHRyYWN0QWxsVG8oemlwUGF0aCwgdG1wUm9vdCk7XG4gICAgY29uc3QgYWxsRXh0cmFjdGVkSXRlbXMgPSBhd2FpdCB3YWxrRGlyKHRtcFJvb3QpO1xuICAgIGxvZ2dlci5kZWJ1ZyhgRXh0cmFjdGVkICR7YWxsRXh0cmFjdGVkSXRlbXMubGVuZ3RofSBpdGVtKHMpIGZyb20gJyR7emlwUGF0aH0nYCk7XG4gICAgY29uc3QgaXNTdXBwb3J0ZWRBcHBJdGVtID0gKHJlbGF0aXZlUGF0aCkgPT4gc3VwcG9ydGVkQXBwRXh0ZW5zaW9ucy5pbmNsdWRlcyhwYXRoLmV4dG5hbWUocmVsYXRpdmVQYXRoKSlcbiAgICAgIHx8IF8uc29tZShzdXBwb3J0ZWRBcHBFeHRlbnNpb25zLCAoeCkgPT4gcmVsYXRpdmVQYXRoLmluY2x1ZGVzKGAke3h9JHtwYXRoLnNlcH1gKSk7XG4gICAgY29uc3QgaXRlbXNUb0tlZXAgPSBhbGxFeHRyYWN0ZWRJdGVtc1xuICAgICAgLm1hcCgoaXRlbVBhdGgpID0+IHBhdGgucmVsYXRpdmUodG1wUm9vdCwgaXRlbVBhdGgpKVxuICAgICAgLmZpbHRlcigocmVsYXRpdmVQYXRoKSA9PiBpc1N1cHBvcnRlZEFwcEl0ZW0ocmVsYXRpdmVQYXRoKSlcbiAgICAgIC5tYXAoKHJlbGF0aXZlUGF0aCkgPT4gcGF0aC5yZXNvbHZlKHRtcFJvb3QsIHJlbGF0aXZlUGF0aCkpO1xuICAgIGNvbnN0IGl0ZW1zVG9SZW1vdmUgPSBfLmRpZmZlcmVuY2UoYWxsRXh0cmFjdGVkSXRlbXMsIGl0ZW1zVG9LZWVwKVxuICAgICAgLy8gQXZvaWQgcGFyZW50IGZvbGRlcnMgdG8gYmUgcmVjdXJzaXZlbHkgcmVtb3ZlZFxuICAgICAgLmZpbHRlcigoaXRlbVRvUmVtb3ZlUGF0aCkgPT4gIV8uc29tZShpdGVtc1RvS2VlcCwgKGl0ZW1Ub0tlZXBQYXRoKSA9PiBpdGVtVG9LZWVwUGF0aC5zdGFydHNXaXRoKGl0ZW1Ub1JlbW92ZVBhdGgpKSk7XG4gICAgYXdhaXQgQi5hbGwoaXRlbXNUb1JlbW92ZSwgYXN5bmMgKGl0ZW1QYXRoKSA9PiB7XG4gICAgICBpZiAoYXdhaXQgZnMuZXhpc3RzKGl0ZW1QYXRoKSkge1xuICAgICAgICBhd2FpdCBmcy5yaW1yYWYoaXRlbVBhdGgpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNvbnN0IGFsbEJ1bmRsZUl0ZW1zID0gKGF3YWl0IHdhbGtEaXIodG1wUm9vdCkpXG4gICAgICAubWFwKChpdGVtUGF0aCkgPT4gcGF0aC5yZWxhdGl2ZSh0bXBSb290LCBpdGVtUGF0aCkpXG4gICAgICAuZmlsdGVyKChyZWxhdGl2ZVBhdGgpID0+IGlzU3VwcG9ydGVkQXBwSXRlbShyZWxhdGl2ZVBhdGgpKVxuICAgICAgLy8gR2V0IHRoZSB0b3AgbGV2ZWwgbWF0Y2hcbiAgICAgIC5zb3J0KChhLCBiKSA9PiBhLnNwbGl0KHBhdGguc2VwKS5sZW5ndGggLSBiLnNwbGl0KHBhdGguc2VwKS5sZW5ndGgpO1xuICAgIGlmIChfLmlzRW1wdHkoYWxsQnVuZGxlSXRlbXMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcCB6aXAgdW56aXBwZWQgT0ssIGJ1dCB3ZSBjb3VsZCBub3QgZmluZCAke3N1cHBvcnRlZEFwcEV4dGVuc2lvbnN9IGJ1bmRsZShzKSBgICtcbiAgICAgICAgYGluIGl0LiBNYWtlIHN1cmUgeW91ciBhcmNoaXZlIGNvbnRhaW5zICR7c3VwcG9ydGVkQXBwRXh0ZW5zaW9uc30gcGFja2FnZShzKSBgICtcbiAgICAgICAgYGFuZCBub3RoaW5nIGVsc2VgKTtcbiAgICB9XG4gICAgY29uc3QgbWF0Y2hlZEJ1bmRsZSA9IF8uZmlyc3QoYWxsQnVuZGxlSXRlbXMpO1xuICAgIGxvZ2dlci5kZWJ1ZyhgTWF0Y2hlZCAke2FsbEJ1bmRsZUl0ZW1zLmxlbmd0aH0gaXRlbShzKSBpbiB0aGUgZXh0cmFjdGVkIGFyY2hpdmUuIGAgK1xuICAgICAgYEFzc3VtaW5nICcke21hdGNoZWRCdW5kbGV9JyBpcyB0aGUgY29ycmVjdCBidW5kbGVgKTtcbiAgICBhd2FpdCBmcy5tdihwYXRoLnJlc29sdmUodG1wUm9vdCwgbWF0Y2hlZEJ1bmRsZSksIHBhdGgucmVzb2x2ZShkc3RSb290LCBtYXRjaGVkQnVuZGxlKSwge1xuICAgICAgbWtkaXJwOiB0cnVlXG4gICAgfSk7XG4gICAgcmV0dXJuIHBhdGgucmVzb2x2ZShkc3RSb290LCBtYXRjaGVkQnVuZGxlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBmcy5yaW1yYWYodG1wUm9vdCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNQYWNrYWdlT3JCdW5kbGUgKGFwcCkge1xuICByZXR1cm4gKC9eKFthLXpBLVowLTlcXC1fXStcXC5bYS16QS1aMC05XFwtX10rKSskLykudGVzdChhcHApO1xufVxuXG5mdW5jdGlvbiBnZXRDb29yZERlZmF1bHQgKHZhbCkge1xuICAvLyBnb2luZyB0aGUgbG9uZyB3YXkgYW5kIGNoZWNraW5nIGZvciB1bmRlZmluZWQgYW5kIG51bGwgc2luY2VcbiAgLy8gd2UgY2FuJ3QgYmUgYXNzdXJlZCBgZWxJZGAgaXMgYSBzdHJpbmcgYW5kIG5vdCBhbiBpbnQuIFNhbWVcbiAgLy8gdGhpbmcgd2l0aCBkZXN0RWxlbWVudCBiZWxvdy5cbiAgcmV0dXJuIHV0aWwuaGFzVmFsdWUodmFsKSA/IHZhbCA6IDAuNTtcbn1cblxuZnVuY3Rpb24gZ2V0U3dpcGVUb3VjaER1cmF0aW9uICh3YWl0R2VzdHVyZSkge1xuICAvLyB0aGUgdG91Y2ggYWN0aW9uIGFwaSB1c2VzIG1zLCB3ZSB3YW50IHNlY29uZHNcbiAgLy8gMC44IGlzIHRoZSBkZWZhdWx0IHRpbWUgZm9yIHRoZSBvcGVyYXRpb25cbiAgbGV0IGR1cmF0aW9uID0gMC44O1xuICBpZiAodHlwZW9mIHdhaXRHZXN0dXJlLm9wdGlvbnMubXMgIT09ICd1bmRlZmluZWQnICYmIHdhaXRHZXN0dXJlLm9wdGlvbnMubXMpIHtcbiAgICBkdXJhdGlvbiA9IHdhaXRHZXN0dXJlLm9wdGlvbnMubXMgLyAxMDAwO1xuICAgIGlmIChkdXJhdGlvbiA9PT0gMCkge1xuICAgICAgLy8gc2V0IHRvIGEgdmVyeSBsb3cgbnVtYmVyLCBzaW5jZSB0aGV5IHdhbnRlZCBpdCBmYXN0XG4gICAgICAvLyBidXQgYmVsb3cgMC4xIGJlY29tZXMgMCBzdGVwcywgd2hpY2ggY2F1c2VzIGVycm9yc1xuICAgICAgZHVyYXRpb24gPSAwLjE7XG4gICAgfVxuICB9XG4gIHJldHVybiBkdXJhdGlvbjtcbn1cblxuLyoqXG4gKiBGaW5kcyBhbGwgaW5zdGFuY2VzICdmaXJzdEtleScgYW5kIGNyZWF0ZSBhIGR1cGxpY2F0ZSB3aXRoIHRoZSBrZXkgJ3NlY29uZEtleScsXG4gKiBEbyB0aGUgc2FtZSB0aGluZyBpbiByZXZlcnNlLiBJZiB3ZSBmaW5kICdzZWNvbmRLZXknLCBjcmVhdGUgYSBkdXBsaWNhdGUgd2l0aCB0aGUga2V5ICdmaXJzdEtleScuXG4gKlxuICogVGhpcyB3aWxsIGNhdXNlIGtleXMgdG8gYmUgb3ZlcndyaXR0ZW4gaWYgdGhlIG9iamVjdCBjb250YWlucyAnZmlyc3RLZXknIGFuZCAnc2Vjb25kS2V5Jy5cblxuICogQHBhcmFtIHsqfSBpbnB1dCBBbnkgdHlwZSBvZiBpbnB1dFxuICogQHBhcmFtIHtTdHJpbmd9IGZpcnN0S2V5IFRoZSBmaXJzdCBrZXkgdG8gZHVwbGljYXRlXG4gKiBAcGFyYW0ge1N0cmluZ30gc2Vjb25kS2V5IFRoZSBzZWNvbmQga2V5IHRvIGR1cGxpY2F0ZVxuICovXG5mdW5jdGlvbiBkdXBsaWNhdGVLZXlzIChpbnB1dCwgZmlyc3RLZXksIHNlY29uZEtleSkge1xuICAvLyBJZiBhcnJheSBwcm92aWRlZCwgcmVjdXJzaXZlbHkgY2FsbCBvbiBhbGwgZWxlbWVudHNcbiAgaWYgKF8uaXNBcnJheShpbnB1dCkpIHtcbiAgICByZXR1cm4gaW5wdXQubWFwKChpdGVtKSA9PiBkdXBsaWNhdGVLZXlzKGl0ZW0sIGZpcnN0S2V5LCBzZWNvbmRLZXkpKTtcbiAgfVxuXG4gIC8vIElmIG9iamVjdCwgY3JlYXRlIGR1cGxpY2F0ZXMgZm9yIGtleXMgYW5kIHRoZW4gcmVjdXJzaXZlbHkgY2FsbCBvbiB2YWx1ZXNcbiAgaWYgKF8uaXNQbGFpbk9iamVjdChpbnB1dCkpIHtcbiAgICBjb25zdCByZXN1bHRPYmogPSB7fTtcbiAgICBmb3IgKGxldCBba2V5LCB2YWx1ZV0gb2YgXy50b1BhaXJzKGlucHV0KSkge1xuICAgICAgY29uc3QgcmVjdXJzaXZlbHlDYWxsZWRWYWx1ZSA9IGR1cGxpY2F0ZUtleXModmFsdWUsIGZpcnN0S2V5LCBzZWNvbmRLZXkpO1xuICAgICAgaWYgKGtleSA9PT0gZmlyc3RLZXkpIHtcbiAgICAgICAgcmVzdWx0T2JqW3NlY29uZEtleV0gPSByZWN1cnNpdmVseUNhbGxlZFZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChrZXkgPT09IHNlY29uZEtleSkge1xuICAgICAgICByZXN1bHRPYmpbZmlyc3RLZXldID0gcmVjdXJzaXZlbHlDYWxsZWRWYWx1ZTtcbiAgICAgIH1cbiAgICAgIHJlc3VsdE9ialtrZXldID0gcmVjdXJzaXZlbHlDYWxsZWRWYWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdE9iajtcbiAgfVxuXG4gIC8vIEJhc2UgY2FzZS4gUmV0dXJuIHByaW1pdGl2ZXMgd2l0aG91dCBkb2luZyBhbnl0aGluZy5cbiAgcmV0dXJuIGlucHV0O1xufVxuXG4vKipcbiAqIFRha2VzIGEgZGVzaXJlZCBjYXBhYmlsaXR5IGFuZCB0cmllcyB0byBKU09OLnBhcnNlIGl0IGFzIGFuIGFycmF5LFxuICogYW5kIGVpdGhlciByZXR1cm5zIHRoZSBwYXJzZWQgYXJyYXkgb3IgYSBzaW5nbGV0b24gYXJyYXkuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd8QXJyYXk8U3RyaW5nPn0gY2FwIEEgZGVzaXJlZCBjYXBhYmlsaXR5XG4gKi9cbmZ1bmN0aW9uIHBhcnNlQ2Fwc0FycmF5IChjYXApIHtcbiAgbGV0IHBhcnNlZENhcHM7XG4gIHRyeSB7XG4gICAgcGFyc2VkQ2FwcyA9IEpTT04ucGFyc2UoY2FwKTtcbiAgICBpZiAoXy5pc0FycmF5KHBhcnNlZENhcHMpKSB7XG4gICAgICByZXR1cm4gcGFyc2VkQ2FwcztcbiAgICB9XG4gIH0gY2F0Y2ggKGlnbikge1xuICAgIGxvZ2dlci53YXJuKGBGYWlsZWQgdG8gcGFyc2UgY2FwYWJpbGl0eSBhcyBKU09OIGFycmF5YCk7XG4gIH1cbiAgaWYgKF8uaXNTdHJpbmcoY2FwKSkge1xuICAgIHJldHVybiBbY2FwXTtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoYG11c3QgcHJvdmlkZSBhIHN0cmluZyBvciBKU09OIEFycmF5OyByZWNlaXZlZCAke2NhcH1gKTtcbn1cblxuZXhwb3J0IHtcbiAgY29uZmlndXJlQXBwLCBpc1BhY2thZ2VPckJ1bmRsZSwgZ2V0Q29vcmREZWZhdWx0LCBnZXRTd2lwZVRvdWNoRHVyYXRpb24sIGR1cGxpY2F0ZUtleXMsIHBhcnNlQ2Fwc0FycmF5XG59O1xuIl0sImZpbGUiOiJsaWIvYmFzZWRyaXZlci9oZWxwZXJzLmpzIiwic291cmNlUm9vdCI6Ii4uLy4uLy4uIn0=
