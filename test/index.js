'use strict';

var chai = require('chai');
var assert = chai.assert;
var chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
var Cordy = require('..');

describe('Cordy', function () {

  it('should be constructable', function () {
    var cordy = new Cordy;

    assert.instanceOf(cordy, Cordy);
  });

  describe('glob()', function () {

    it('should match only HTML files', function () {
      var cordy = new Cordy;
      var actual = cordy.glob('test/glob/**/*.html');
      var expected = [
        'test/glob/page-1.html',
        'test/glob/page-2.html'
      ];

      assert.eventually.deepEqual(actual, expected);
    });

  });

  describe('buildSitemap()', function () {

    // @todo Check if generated sitemap HTML is equal to expected value
    it('should build a sitemap from a directory of HTML files', function () {
      var cordy = new Cordy;
      var actual = cordy.buildSitemap('test/glob/**/*.html');

      assert.eventually.isString(actual);
    });

  });

  describe('buildFilenameFromURI()', function () {

    it('should return filename for index page', function () {
      var cordy = new Cordy;
      var actual = cordy.buildFilenameFromURI('http://example.com');
      var expected = 'index.html';

      assert.strictEqual(actual, expected);
    });

    it('should return filename with only safe characters', function () {
      var cordy = new Cordy;
      var actual = cordy.buildFilenameFromURI('http://example.com/grándpárent/parent/child');
      var expected = 'grándpárent-parent-child.html';

      assert.strictEqual(actual, expected);
    });

  });

//  it('should build page tasks', function () {
//    var cordy = new Cordy;
//    var actual = cordy.buildTasks({
//      url: 'http://example.com'
//    });
//    var expected = [
//      ['goto', 'http://example.com']
//    ];
//
//    assert.deepEqual(actual, expected);
//  });

});
