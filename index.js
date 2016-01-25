var constants = require('constants')
var hypercore = require('hypercore')
var fs = require('fs')
var bulk = require('bulk-write-stream')
var rabin = require('rabin')
var path = require('path')
var deltas = require('delta-list')
var from = require('from2')
var pump = require('pump')
var pumpify = require('pumpify')
var octal = require('octal')
var util = require('util')
var events = require('events')
var storage = require('./lib/storage')
var messages = require('./lib/messages')

var DMODE = octal(755)
var FMODE = octal(644)

module.exports = Hyperdrive

function Hyperdrive (db) {
  if (!(this instanceof Hyperdrive)) return new Hyperdrive(db)

  this.db = db
  this.core = hypercore(db, {
    storage: storage
  })
}

Hyperdrive.prototype.createPeerStream = function () {
  return this.core.createPeerStream()
}

Hyperdrive.prototype.get = function (id, folder) {
  return new Archive(this, folder, id)
}

Hyperdrive.prototype.add = function (folder) {
  return new Archive(this, folder, null)
}

function Archive (drive, folder, id) {
  events.EventEmitter.call(this)

  var self = this

  this.id = id
  this.directory = folder
  this.core = drive.core
  this.entries = 0

  if (!id) {
    this.feed = this.core.add({filename: null})
  } else {
    this.feed = this.core.get(id)
  }

  this.feed.on('put', function (block, data) {
    self.emit('download', data, block)
  })

  this.feed.ready(function (err) {
    if (err) return
    self.entries = self.feed.blocks
    self.emit('ready')
  })
}

util.inherits(Archive, events.EventEmitter)

Archive.prototype.ready = function (cb) {
  this.feed.ready(cb)
}

Archive.prototype.select = function (i, cb) {
  if (!cb) cb = noop
  var self = this
  this.entry(i, function (err, entry) {
    if (err) return cb(err)
    if (!entry || !entry.link) return cb(null, null)
    cb(null, self._getFeed(entry))
  })
}

Archive.prototype.deselect = function (i, cb) {
  throw new Error('not yet implemented')
}

Archive.prototype.entry = function (i, cb) {
  this.feed.get(i, function (err, data) {
    if (err) return cb(err)
    if (!data) return cb(null, null)
    cb(null, messages.Entry.decode(data))
  })
}

Archive.prototype.finalize = function (cb) {
  if (!cb) cb = noop
  var self = this
  this.feed.finalize(function (err) {
    if (err) return cb(err)
    self.id = self.feed.id
    self.entries = self.feed.blocks
    cb()
  })
}

Archive.prototype.createEntryStream = function (opts) {
  if (!opts) opts = {}
  var start = opts.start || 0
  var limit = opts.limit || Infinity
  var self = this
  return from.obj(read)

  function read (size, cb) {
    if (limit-- === 0) return cb(null, null)
    self.entry(start++, cb)
  }
}

Archive.prototype._getFeed = function (entry) {
  if (!entry.link) return null

  var self = this
  var contentBlocks = entry.link.blocks - entry.link.index.length
  var feed = this.core.get(entry.link.id, {
    filename: path.join(this.directory, entry.name),
    index: deltas.unpack(entry.link.index),
    contentBlocks: contentBlocks
  })

  feed.on('put', function (block, data) {
    self.emit('file-download', entry, data, block)
  })

  feed.open(function (err) {
    if (err) return
    for (var i = 0; i < entry.link.index.length; i++) {
      if (!feed.has(i + contentBlocks)) feed.want.push({block: i + contentBlocks, callback: noop, critical: true})
    }
  })

  return feed
}

Archive.prototype.createFileCursor = function (i, opts) {
  throw new Error('not yet implemented')
}

Archive.prototype.createFileStream = function (i, opts) { // TODO: expose random access stuff
  if (!opts) opts = {}
  var start = opts.start || 0
  var limit = opts.limit || Infinity
  var self = this
  var feed = null
  return from.obj(read)

  function read (size, cb) {
    if (feed) {
      if (limit-- === 0) return cb(null, null)
      feed.get(start++, cb)
      return
    }

    self.entry(i, function (err, entry) {
      if (err) return cb(err)
      if (!entry.link) return cb(null, null)
      feed = self._getFeed(entry)
      limit = Math.min(limit, entry.link.blocks - entry.link.index.length)
      read(0, cb)
    })
  }
}

Archive.prototype.append = function (entry, opts, cb) {
  if (typeof opts === 'function') return this.append(entry, null, opts)
  if (typeof entry === 'string') entry = {name: entry, type: 'file'}
  if (!entry.name) throw new Error('entry.name is required')
  if (!entry.type && entry.mode) entry.type = modeToType(entry.mode)
  if (entry.type && !entry.mode) entry.mode = entry.type === 'directory' ? DMODE : FMODE
  if (!opts) opts = {}

  var self = this

  if (entry.type !== 'file') {
    append(null, cb)
    return null
  }

  if (opts.filename === true) opts.filename = entry.name

  var size = 0
  var feed = this.core.add({filename: opts.filename && path.join(this.directory, opts.filename)})
  var stream = pumpify(rabin(), bulk(write, end))

  if (cb) {
    stream.on('error', cb)
    stream.on('finish', cb)
  }

  return stream

  function append (link, cb) {
    entry.size = size
    entry.link = link
    self.feed.append(messages.Entry.encode(entry), done)

    function done (err) {
      if (err) return cb(err)
      self.entries++
      cb(null)
    }
  }

  function write (buffers, cb) {
    for (var i = 0; i < buffers.length; i++) size += buffers[i].length
    feed.append(buffers, cb)
  }

  function end (cb) {
    feed.finalize(function (err) {
      if (err) return cb(err)

      var link = {
        id: feed.id,
        blocks: feed.blocks,
        index: deltas.pack(feed._storage._index)
      }

      append(link, cb)
    })
  }
}

Archive.prototype.appendFile = function (filename, name, cb) {
  if (typeof name === 'function') return this.appendFile(filename, null, name)
  if (!cb) cb = noop
  if (!name) name = filename

  var self = this

  fs.lstat(filename, function (err, st) {
    if (err) return cb(err)

    var ws = self.append({
      name: name,
      mode: st.mode,
      size: 0
    }, {filename: filename}, cb)

    if (ws) pump(fs.createReadStream(path.join(self.directory, filename)), ws)
  })
}

function noop () {}

function modeToType (mode) { // from tar-stream
  switch (mode & constants.S_IFMT) {
    case constants.S_IFBLK: return 'block-device'
    case constants.S_IFCHR: return 'character-device'
    case constants.S_IFDIR: return 'directory'
    case constants.S_IFIFO: return 'fifo'
    case constants.S_IFLNK: return 'symlink'
  }

  return 'file'
}
