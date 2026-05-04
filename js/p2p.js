/**
 * P2P connection module using PeerJS (WebRTC)
 * Room token is hashed to create a deterministic peer ID.
 * First peer to register becomes the host; others connect to it.
 * Host relays messages between all peers.
 */

const P2P = (() => {
  const CHUNK_SIZE = 16 * 1024; // 16KB chunks for data channel
  const MAX_JOIN_RETRIES = 5;
  const JOIN_RETRY_DELAY = 1500; // ms

  let _peer = null;
  let _connections = []; // all active DataConnections
  let _isHost = false;
  let _myPeerId = null;
  let _onMessage = null;
  let _onPeerJoin = null;
  let _onPeerLeave = null;
  let _onFileMeta = null;
  let _onFileChunk = null;
  let _onFileComplete = null;
  let _onStatus = null;
  let _onError = null;

  // Receive buffers for file transfers: key = transferId
  const _fileBuffers = new Map();

  function on(event, callback) {
    switch (event) {
      case 'message': _onMessage = callback; break;
      case 'peerJoin': _onPeerJoin = callback; break;
      case 'peerLeave': _onPeerLeave = callback; break;
      case 'fileMeta': _onFileMeta = callback; break;
      case 'fileChunk': _onFileChunk = callback; break;
      case 'fileComplete': _onFileComplete = callback; break;
      case 'status': _onStatus = callback; break;
      case 'error': _onError = callback; break;
    }
  }

  function emit(event, ...args) {
    const cb = { message: _onMessage, peerJoin: _onPeerJoin, peerLeave: _onPeerLeave,
      fileMeta: _onFileMeta, fileChunk: _onFileChunk, fileComplete: _onFileComplete,
      status: _onStatus, error: _onError }[event];
    if (cb) cb(...args);
  }

  async function hashToken(token) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode('im-room:' + token));
    return Array.from(new Uint8Array(hash.slice(0, 16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function setupConnection(conn) {
    _connections.push(conn);

    conn.on('open', () => {
      emit('status', `Peer connected: ${conn.peer.slice(0, 8)}...`);
      emit('peerJoin', conn.peer, _connections.length);
      broadcast({ type: 'peerCount', count: _connections.length }, null);
    });

    conn.on('data', (data) => {
      handleData(conn, data);
    });

    conn.on('close', () => {
      _connections = _connections.filter(c => c !== conn);
      emit('peerLeave', conn.peer, _connections.length);
      emit('status', `Peer disconnected. ${_connections.length} peer(s) remaining.`);
      broadcast({ type: 'peerCount', count: _connections.length }, null);
    });

    conn.on('error', (err) => {
      emit('error', `Connection error: ${err}`);
    });
  }

  function handleData(conn, data) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      // Binary data = file chunk
      handleFileChunk(data);
      // Relay binary to other peers if host
      if (_isHost) broadcast(data, conn);
      return;
    }

    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        switch (msg.type) {
          case 'chat':
            emit('message', msg.payload, conn.peer);
            // Relay to all other peers if host
            if (_isHost) broadcast(data, conn);
            break;
          case 'fileMeta':
            _fileBuffers.set(msg.transferId, {
              name: msg.name, size: msg.size, type: msg.mime,
              chunks: [], received: 0, totalChunks: msg.totalChunks
            });
            emit('fileMeta', msg);
            // Relay to other peers if host
            if (_isHost) broadcast(data, conn);
            break;
          case 'fileEnd': {
            const buf = _fileBuffers.get(msg.transferId);
            if (buf) {
              const blob = new Blob(buf.chunks, { type: buf.type });
              emit('fileComplete', msg.transferId, blob, buf.name, buf.size);
              _fileBuffers.delete(msg.transferId);
            }
            // Relay to other peers if host
            if (_isHost) broadcast(data, conn);
            break;
          }
          case 'peerCount':
            break;
        }
      } catch {
        emit('message', data, conn.peer);
        if (_isHost) broadcast(data, conn);
      }
    }
  }

  function handleFileChunk(data) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const view = new DataView(buf);
    const idLen = view.getUint16(0);
    const decoder = new TextDecoder();
    const transferId = decoder.decode(new Uint8Array(buf, 2, idLen));
    const chunkData = new Uint8Array(buf, 2 + idLen);

    const fileBuf = _fileBuffers.get(transferId);
    if (fileBuf) {
      fileBuf.chunks.push(chunkData);
      fileBuf.received++;
      emit('fileChunk', transferId, fileBuf.received, fileBuf.totalChunks, fileBuf.size);
    }
  }

  function createPeer(id) {
    return new Peer(id, {
      debug: 0,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });
  }

  async function connect(token) {
    _isHost = false;
    _connections = [];
    const hostPeerId = await hashToken(token);

    return new Promise((resolve, reject) => {
      _peer = createPeer(hostPeerId);

      _peer.on('open', (id) => {
        _myPeerId = id;
        _isHost = true;
        emit('status', 'Room created. Waiting for peers...');
        resolve({ peerId: id, isHost: true });
      });

      _peer.on('connection', (conn) => {
        setupConnection(conn);
      });

      _peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          _peer.destroy();
          _peer = null;
          joinExistingWithRetry(hostPeerId, 0).then(resolve).catch(reject);
        } else if (err.type === 'peer-unavailable') {
          emit('error', 'Room not found. Make sure the host has created the room first.');
          reject(err);
        } else {
          emit('error', `PeerJS error: ${err.type} - ${err.message}`);
          reject(err);
        }
      });

      _peer.on('disconnected', () => {
        emit('status', 'Disconnected from signaling server. Attempting reconnect...');
        if (_peer) _peer.reconnect();
      });
    });
  }

  function joinExistingWithRetry(hostPeerId, attempt) {
    return new Promise((resolve, reject) => {
      const myId = hostPeerId + '-' + Math.random().toString(36).slice(2, 8);
      _peer = createPeer(myId);

      _peer.on('open', () => {
        _myPeerId = myId;
        _isHost = false;
        const conn = _peer.connect(hostPeerId, { reliable: true });
        conn.on('open', () => {
          setupConnection(conn);
          emit('status', 'Connected to room.');
          resolve({ peerId: myId, isHost: false });
        });
        conn.on('error', (err) => {
          if (attempt < MAX_JOIN_RETRIES) {
            emit('status', `Connection attempt failed, retrying (${attempt + 1}/${MAX_JOIN_RETRIES})...`);
            _peer.destroy();
            _peer = null;
            setTimeout(() => {
              joinExistingWithRetry(hostPeerId, attempt + 1).then(resolve).catch(reject);
            }, JOIN_RETRY_DELAY);
          } else {
            emit('error', `Failed to connect to host after ${MAX_JOIN_RETRIES} attempts.`);
            reject(err);
          }
        });
      });

      _peer.on('connection', (conn) => {
        setupConnection(conn);
      });

      _peer.on('error', (err) => {
        if (attempt < MAX_JOIN_RETRIES) {
          _peer.destroy();
          _peer = null;
          setTimeout(() => {
            joinExistingWithRetry(hostPeerId, attempt + 1).then(resolve).catch(reject);
          }, JOIN_RETRY_DELAY);
        } else {
          emit('error', `PeerJS error: ${err.type} - ${err.message}`);
          reject(err);
        }
      });
    });
  }

  // Broadcast data to all connections, optionally excluding a sender
  function broadcast(data, excludeConn) {
    for (const conn of _connections) {
      if (conn !== excludeConn && conn.open) {
        conn.send(data);
      }
    }
  }

  function sendMessage(text) {
    broadcast(JSON.stringify({ type: 'chat', payload: text }), null);
  }

  async function sendFile(file) {
    const transferId = crypto.getRandomValues(new Uint8Array(16))
      .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    broadcast(JSON.stringify({
      type: 'fileMeta',
      transferId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks
    }), null);

    const buffer = await file.arrayBuffer();
    const enc = new TextEncoder();
    const idBytes = enc.encode(transferId);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
      const chunk = new Uint8Array(buffer.slice(start, end));

      const packet = new Uint8Array(2 + idBytes.length + chunk.length);
      const view = new DataView(packet.buffer);
      view.setUint16(0, idBytes.length);
      packet.set(idBytes, 2);
      packet.set(chunk, 2 + idBytes.length);

      broadcast(packet, null);

      if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    broadcast(JSON.stringify({ type: 'fileEnd', transferId }), null);
    return transferId;
  }

  function getPeerCount() {
    return _connections.filter(c => c.open).length;
  }

  function disconnect() {
    for (const conn of _connections) {
      conn.close();
    }
    _connections = [];
    _fileBuffers.clear();
    if (_peer) {
      _peer.destroy();
      _peer = null;
    }
    _isHost = false;
    _myPeerId = null;
  }

  return {
    connect, sendMessage, sendFile, disconnect,
    on, getPeerCount, hashToken
  };
})();
