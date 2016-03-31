'use strict';

var _ = require('lodash');
var chalk = require('chalk');
var EventEmitter = require('events');
var fs = require('fs');
var glob = require('glob');
var mkdirp = require('mkdirp');
var Nightmare = require('nightmare');
var path = require('path');
var Promise = require('bluebird');
var relToAbs = require('rel-to-abs');
var rimraf = require('rimraf');
var sanitizeFilename = require('sanitize-filename');
var slash = require('slash');
var sitemap = require('sitemap');
var url = require('url');
var util = require('util');

Promise.promisifyAll(fs);
var mkdirpAsync = Promise.promisify(mkdirp);
var rimrafAsync = Promise.promisify(rimraf);

function Cordy() {
  EventEmitter.call(this);
}

util.inherits(Cordy, EventEmitter);

/**
 * Builds cache.
 *
 * @param {Object} options
 * @returns {Promise}
 */
Cordy.prototype.buildCache = function (options) {
  var defaultSitemapOptions = {
    baseURL: undefined
  };

  var defaultOptions = {
    cleanDest: false,
    urls: [],
    dest: undefined,
    sitemap: defaultSitemapOptions
  };

  if (_.isNil(options)) {
    options = defaultOptions;
  }
  else {
    _.defaults(options, defaultOptions);
  }

  if (_.isNil(options.sitemap)) {
    options.sitemap = defaultSitemapOptions;
  }
  else {
    _.defaults(options.sitemap, defaultSitemapOptions);
  }

  if (_.isNil(options.dest)) {
    return Promise.reject('buildCache() `options.dest` is required');
  }

  var self = this;

  // Build array of values for mapper function.
  var values = [];

  _.forEach(options.urls, function (url) {
    values.push({
      src: url.url,
      baseURL: url.baseURL,
      auth: url.auth,
      dest: options.dest
    });
  });

  // Fetches and saves HTML of all URLs, and builds and saves sitemap.
  var alwaysFn = function () {
    // Create destination directory.
    return mkdirpAsync(options.dest)
      // Save HTML.
      .then(function () {
        // Run map function on all URLs. Note that map loop exits on first rejection.
        return Promise.map(values, function (options) {
          var auth = options.auth;
          var src = options.src;
          var baseURL = options.baseURL;
          var nightmareOptions = options.nightmare;
          var dest = options.dest;

          var saveHTMLFn = function () {
            return self.saveHTML(src, nightmareOptions, baseURL, dest);
          };

          if (_.isFunction(auth)) {
            return auth()
              .then(saveHTMLFn);
          }

          return saveHTMLFn();
        }, {
          concurrency: 1
        });
      })
      // Create sitemap.
      .then(function () {
        return self.saveSitemap(options.dest + '/**/*.html', null, options.sitemap, options.dest + '/sitemap.xml');
      });
  };

  if (options.cleanDest) {
    return this.cleanDirectory(options.dest)
      .then(alwaysFn);
  }

  return alwaysFn();
};

/**
 * Fetches HTML for a given URL, and writes HTML to file.
 *
 * @param {String} src
 * @param {Object} nightmareOptions
 * @returns {Promise}
 */
Cordy.prototype.getHTML = function (src, nightmareOptions) {
  if (_.isNil(src)) {
    return Promise.reject('getHTML() `src` is required');
  }

  return this.runTasks([
    ['goto', src],
    ['evaluate', function () {
        return new XMLSerializer().serializeToString(document);
      }],
  ], nightmareOptions);
};

/**
 * Fetches HTML for a given URL, and writes HTML to file.
 *
 * @param {String} src
 * @param {Object} nightmareOptions
 * @param {String} baseURL
 * @param {String} dest
 * @returns {Promise}
 */
Cordy.prototype.saveHTML = function (src, nightmareOptions, baseURL, dest) {
  if (_.isNil(src)) {
    return Promise.reject('saveHTML() `src` is required');
  }
  else if (_.isNil(dest)) {
    return Promise.reject('saveHTML() `dest` is required');
  }

  var self = this;
  var file = dest + '/' + this.buildFilenameFromURI(src);
  var srcParsed = url.parse(src);

  if (_.isNil(baseURL)) {
    baseURL = url.format({
      host: srcParsed.host,
      protocol: srcParsed.protocol
    });
  }

  return this.getHTML(src, nightmareOptions)
    .then(function (data) {
      data = self.relToAbs(data, baseURL);
      return self.writeFile(file, data);
    });
};

/**
 * Runs the given Nightmare tasks.
 *
 * @param {Array} tasks
 * @param {Object} options
 * @returns {Promise}
 */
Cordy.prototype.runTasks = function (tasks, options) {
  var self = this;

  this.emit('runTasks', tasks);

  return new Promise(function (resolve, reject) {
    var flags = {
      error: false // Whether one or more tasks threw an error
    };
    var gotoStack = [];
    var nightmare = Nightmare(options);

    nightmare.on('did-get-response-details', function (event, status, newURL, originalURL, httpResponseCode, requestMethod, referrer, headers) {
      // Handle HTTP errors thrown by goto tasks
      var gotoIndex = _.findIndex(gotoStack, function (o) {
        return newURL === o.url && false === o.flags.run;
      });

      if (gotoIndex > -1) {
        gotoStack[gotoIndex].flags.run = true;
        gotoStack[gotoIndex].httpResponseCode = httpResponseCode;

        // Client (400) or server (500) error
        if (httpResponseCode >= 400) {
          flags.error = true;
          self.emit('httpError', newURL, httpResponseCode);
        }
      }
    });

    _.forEach(tasks, function (value, index) {
      var task = value[0];
      var args = _.slice(value, 1);

      if ('goto' === task) {
        gotoStack.push({
          url: args[0],
          flags: {
            run: false
          },
          httpResponseCode: undefined
        });
      }

      nightmare[task].apply(nightmare, args);
    });

    return nightmare.end().then(function () {
      if (flags.error) {
        reject();
      }
      else {
        resolve.apply(nightmare, arguments);
      }
    }, reject);
  });
};

/**
 * Returns a filename from a given URI without unsafe characters.
 *
 * @param {type} uri URI
 * @param {String} extension File extension (optional). Default: .html
 * @returns {String}
 */
Cordy.prototype.buildFilenameFromURI = function (uri, extension) {
  if (_.isNil(extension)) {
    extension = '.html';
  }

  var uriParsed = url.parse(uri);
  var filename = _.trim(uriParsed.pathname, '/\\');

  if (!filename.length) {
    filename = 'index';
  }

  filename = sanitizeFilename(filename, {
    replacement: '-'
  });

  if (!filename.length) {
    return filename;
  }

  if (path.extname(filename).toLowerCase() === extension) {
    return filename;
  }

  return filename + extension;
};

/**
 * Deletes all files and directories in a given directory.
 *
 * @param {String} directory
 * @returns {Promise}
 */
Cordy.prototype.cleanDirectory = function (directory) {
  if (_.isNil(directory)) {
    return Promise.reject('cleanDirectory() `directory` is required');
  }
  else if (!directory.length) {
    return Promise.reject('cleanDirectory() `directory` is empty');
  }

  return rimrafAsync(directory + '/**/*');
};

/**
 * Writes data to a file.
 *
 * @param {String} file Path to file
 * @param {String} data
 * @returns {Promise}
 */
Cordy.prototype.writeFile = function (file, data) {
  if (_.isNil(file)) {
    return Promise.reject('writeFile() `file` is required');
  }

  return fs.writeFileAsync(file, data);
};

/**
 *
 * @param {String} data
 * @param {String} baseURL
 * @returns {String}
 */
Cordy.prototype.relToAbs = function (data, baseURL) {
  return relToAbs.convert(data, baseURL);
};

/**
 * Matches paths.
 *
 * @param {String} pattern
 * @param {Object} options
 * @returns {Promise}
 */
Cordy.prototype.glob = function (pattern, options) {
  return new Promise(function (resolve, reject) {
    glob(pattern, options, function (err, paths) {
      return err === null ? resolve(paths) : reject(err);
    });
  });
};

/**
 * Matches and stats paths.
 *
 * @param {String} pattern
 * @param {Object} options
 * @returns {Promise}
 */
Cordy.prototype.globStat = function (pattern, options) {
  return this.glob(pattern, options)
    .then(function (paths) {
      return Promise
        .map(paths, function (path) {
          return fs.statAsync(path)
            .then(function (stat) {
              stat.path = slash(path);
              return stat;
            });
        })
        .then(function (stats) {
          return stats;
        });
    });
};

/**
 * Builds a sitemap from matched paths.
 *
 * @param {String} globPattern
 * @param {Object} globOptions
 * @param {Object} sitemapOptions
 * @returns {Promise}
 */
Cordy.prototype.buildSitemap = function (globPattern, globOptions, sitemapOptions) {
  var defaultSitemapOptions = {
    'baseURL': 'http://localhost'
  };

  if (_.isNil(sitemapOptions)) {
    sitemapOptions = defaultSitemapOptions;
  }
  else {
    _.defaults(sitemapOptions, defaultSitemapOptions);
  }

  sitemapOptions.baseURL = _.trimEnd(sitemapOptions.baseURL, '/');

  return this.globStat(globPattern, globOptions)
    .then(function (files) {
      var urls = [];

      _.forEach(files, function (file) {
        urls.push({
          url: '/' + _.trimStart(file.path, '/'),
          lastmodISO: new Date(file.mtime || Date.now()).toISOString()
        });
      });

      return sitemap.createSitemap({
        hostname: sitemapOptions.baseURL,
        urls: urls
      }).toString();
    });
};

/**
 *
 * @param {String} globPattern
 * @param {Object} globOptions
 * @param {Object} sitemapOptions
 * @param {String} dest
 * @returns {Promise}
 */
Cordy.prototype.saveSitemap = function (globPattern, globOptions, sitemapOptions, dest) {
  if (_.isNil(dest)) {
    dest = 'sitemap.xml';
  }

  var self = this;

  // Build sitemap contents.
  return this.buildSitemap(globPattern, globOptions, sitemapOptions)
    // Write sitemap contents to file.
    .then(function (data) {
      return self.writeFile(dest, data);
    });
};

module.exports = Cordy;
