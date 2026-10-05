const net = require('node:net');
net.Socket.prototype.connect = () => { throw new Error('Unexpected offline child-process network request'); };
globalThis.fetch = () => { throw new Error('Unexpected offline child-process fetch'); };
