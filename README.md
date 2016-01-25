# hyperdrive

A file sharing network based on [rabin](https://github.com/maxogden/rabin) file chunking and append only feeds of data verified by merkle trees.

```
npm install hyperdrive
```

[![build status](http://img.shields.io/travis/mafintosh/hyperdrive.svg?style=flat)](http://travis-ci.org/mafintosh/hyperdrive)

For a more detailed technical information on how it works see [SPECIFICATION.md](SPECIFICATION.md). It runs in node.js as well as in the browser. [Try a browser based demo here](http://mafintosh.github.io/hyperdrive)

## Usage

First create a new feed to share

``` js
var hyperdrive = require('hyperdrive')
var level = require('level')

var db = levelup('./hyperdrive.db')
var drive = hyperdrive(db)

var pack = drive.add('./some-folder')

pack.appendFile('my-file.txt', function (err) {
  if (err) throw err
  pack.finalize(function () {
    var link = pack.id.toString('hex')
    console.log(link, '<-- this is your hyperdrive link')
  })
})
```

Then to share it

``` js
var disc = require('discovery-channel')()
var hyperdrive = require('hyperdrive')
var net = require('net')
var level = require('level')
var db = levelup('./another-hyperdrive.db')
var drive = hyperdrive(db)

var link = new Buffer({your-hyperdrive-link-from-the-above-example}, 'hex')

var server = net.createServer(function (socket) {
  socket.pipe(drive.createPeerStream()).pipe(socket)
})

server.listen(0, function () {
  disc.add(link, server.address().port)
  disc.on('peer', function (hash, peer) {
    var socket = net.connect(peer.port, peer.host)
    socket.pipe(drive.createPeerStream()).pipe(socket)
  })
})
```

If you run this code on multiple computers you should be able to access
the content in the feed by doing

``` js
var archive = drive.get(link, './folder-to-store-data-in') // the link identifies/verifies the content

archive.entry(0, function (err, entry) { // get the first entry
  console.log(entry) // prints {name: 'my-file.txt', ...}
  var stream = archive.createFileStream(0)
  stream.on('data', function (data) {
    console.log(data) // <-- file data
  })
  stream.on('end', function () {
    console.log('no more data')
  })
})
```

## API

#### `var drive = hyperdrive(db)`

Create a new hyperdrive instance. db should be a [levelup](https://github.com/level/levelup) instance.
You can add a folder to store the file data in as the second argument.

#### `var stream = drive.createPeerStream()`

Create a new peer replication duplex stream. This stream should be piped together with another
peer stream somewhere else to start replicating the feeds

#### `var archive = drive.add([basefolder])`

Add a new archive to share. `basefolder` will be the root of this archive.

#### `var archive = drive.get(id, [basefolder])`

Retrive a finalized archive.

#### `archive.appendFile(filename, [name], [callback])`

Append a file to a non-finalized archive. If you don't specify `name` the entry will be called `filename`.

#### `archive.finalize([callback])`

Finalize an archive. After an archive is finalized it will be sharable and will have a `.id` property.

#### `archive.ready(callback)`

Wait for the archive to be ready. Afterwards `archive.entries` will contain the total amount of entries available.

#### `archive.entry(index, callback)`

Read the entry metadata stored at `index`. An metadata entry looks like this

``` js
{
  type: 'file-or-directory',
  name: 'filename',
  mode: fileMode,
  size: fileSize,
  uid: optionalUid,
  gid: optionalGid,
  mtime: optionalMtimeInSeconds,
  ctime: optionalCtimeInSeconds
}
```

#### `var rs = archive.createFileStream(index)`

Create a stream to a file.

#### `var rs = archive.createEntryStream()`

Stream out all metadata entries

## License

MIT
