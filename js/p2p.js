/**
 * P2P connection module using PeerJS (WebRTC)
 * Room token is hashed to create a deterministic peer ID.
 * First peer to register becomes the host; others connect to it.
 * Host relays messages between all peers.
 *
 * ICE config includes TURN servers for cellular/symmetric-NAT traversal.
 */

const P2P = (() => {
  const CHUNK_SIZE = 16 * 1024;
  const MAX_JOIN_RETRIES = 5;
  const JOIN_RETRY_DELAY = 3000;
  const CONNECT_TIMEOUT = 45000; // 45s per attempt (cellular ICE gathering is slower)
  const OUTGOING_TRANSFER_TTL = 5 * 60 * 1000; // keep sent chunks in memory for 5min

  // ICE servers for NAT traversal
  // config.iceServers replaces PeerJS defaults, so include STUN explicitly.
  // Kept lean (4 servers) to avoid SDP bloat that breaks PeerJS signaling.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN UDP — best performance when relay needed
    {
      urls: 'turn:openrelay.metered.ca:443?transport=udp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    // TURN TCP — fallback when UDP is blocked (common on cellular)
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  let _peer = null;
  let _connections = [];
  let _isHost = false;
  let _myPeerId = null;
  let _connectTimer = null;
  let _onMessage = null;
  let _onPeerJoin = null;
  let _onPeerLeave = null;
  let _onFileMeta = null;
  let _onFileChunk = null;
  let _onFileComplete = null;
  let _onStatus = null;
  let _onError = null;
  let _onConnState = null; // connection state changes
  let _onFileResendExpired = null;
  let _onPong = null;

  const _fileBuffers = new Map();
  const _outgoingTransfers = new Map();

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
      case 'connState': _onConnState = callback; break;
      case 'fileResendExpired': _onFileResendExpired = callback; break;
      case 'pong': _onPong = callback; break;
    }
  }

  function emit(event, ...args) {
    const cb = {
      message: _onMessage, peerJoin: _onPeerJoin, peerLeave: _onPeerLeave,
      fileMeta: _onFileMeta, fileChunk: _onFileChunk, fileComplete: _onFileComplete,
      status: _onStatus, error: _onError, connState: _onConnState,
      fileResendExpired: _onFileResendExpired, pong: _onPong
    }[event];
    if (cb) cb(...args);
  }

  async function hashToken(token) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode('im-room:' + token));
    return Array.from(new Uint8Array(hash.slice(0, 16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function createPeer(id) {
    return new Peer(id, {
      debug: 0,
      config: {
        iceServers: ICE_SERVERS,
        iceTransportPolicy: 'all', // try direct first, then relay
        sdpSemantics: 'unified-plan',
        iceCandidatePoolSize: 10   // pre-gather candidates to speed up ICE on mobile
      }
    });
  }

  function setupConnection(conn) {
    _connections.push(conn);

    conn.on('open', () => {
      clearConnectTimeout();
      emit('connState', 'connected');
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

  function packChunk(transferId, chunkIndex, chunkData) {
    const enc = new TextEncoder();
    const idBytes = enc.encode(transferId);
    const packet = new Uint8Array(2 + idBytes.length + 4 + chunkData.length);
    const view = new DataView(packet.buffer);
    view.setUint16(0, idBytes.length);
    packet.set(idBytes, 2);
    view.setUint32(2 + idBytes.length, chunkIndex);
    packet.set(chunkData, 2 + idBytes.length + 4);
    return packet;
  }

  function unpackChunk(data) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const view = new DataView(buf);
    const idLen = view.getUint16(0);
    const decoder = new TextDecoder();
    const transferId = decoder.decode(new Uint8Array(buf, 2, idLen));
    const chunkIndex = view.getUint32(2 + idLen);
    const chunkData = new Uint8Array(buf, 2 + idLen + 4);
    return { transferId, chunkIndex, chunkData };
  }

  function handleData(conn, data) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      handleFileChunk(data);
      if (_isHost) broadcast(data, conn);
      return;
    }

    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        switch (msg.type) {
          case 'chat':
            emit('message', msg.payload, conn.peer);
            if (_isHost) broadcast(data, conn);
            break;
          case 'fileMeta':
            _fileBuffers.set(msg.transferId, {
              name: msg.name, size: msg.size, type: msg.mime,
              chunks: new Array(msg.totalChunks).fill(null),
              receivedChunks: new Set(),
              totalChunks: msg.totalChunks
            });
            emit('fileMeta', msg);
            if (_isHost) broadcast(data, conn);
            break;
          case 'fileEnd': {
            const buf = _fileBuffers.get(msg.transferId);
            if (buf) {
              if (buf.receivedChunks.size === buf.totalChunks) {
                const blob = new Blob(buf.chunks.filter(c => c !== null), { type: buf.type });
                emit('fileComplete', msg.transferId, blob, buf.name, buf.size);
                _fileBuffers.delete(msg.transferId);
              } else {
                const missing = [];
                for (let i = 0; i < buf.totalChunks; i++) {
                  if (!buf.receivedChunks.has(i)) missing.push(i);
                }
                emit('status', `Resuming ${buf.name}: requesting ${missing.length} missing chunks...`);
                broadcast(JSON.stringify({
                  type: 'fileResend',
                  transferId: msg.transferId,
                  missing
                }), null);
              }
            }
            if (_isHost) broadcast(data, conn);
            break;
          }
          case 'fileResend': {
            const t = _outgoingTransfers.get(msg.transferId);
            if (t && msg.missing && msg.missing.length > 0) {
              // Only send re-requested chunks back to the requesting peer
              _sendChunksToPeer(conn, msg.transferId, msg.missing);
            } else if (!t && msg.missing && msg.missing.length > 0) {
              // Sender's cache expired — notify requester
              conn.send(JSON.stringify({
                type: 'fileResendExpired',
                transferId: msg.transferId
              }));
            }
            if (_isHost) broadcast(data, conn);
            break;
          }
          case 'fileResendExpired': {
            emit('fileResendExpired', msg.transferId);
            _fileBuffers.delete(msg.transferId);
            if (_isHost) broadcast(data, conn);
            break;
          }
          case 'peerCount':
            break;
          case 'ping':
            // Auto-reply with pong
            conn.send(JSON.stringify({ type: 'pong', id: msg.id, t: msg.t }));
            break;
          case 'pong':
            emit('pong', msg.id, msg.t);
            break;
        }
      } catch {
        emit('message', data, conn.peer);
        if (_isHost) broadcast(data, conn);
      }
    }
  }

  async function handleFileChunk(data) {
    const { transferId, chunkIndex, chunkData } = unpackChunk(data);

    const fileBuf = _fileBuffers.get(transferId);
    if (fileBuf) {
      if (!fileBuf.receivedChunks.has(chunkIndex)) {
        try {
          const decrypted = await Crypto.decryptBytes(chunkData);
          fileBuf.chunks[chunkIndex] = decrypted;
          fileBuf.receivedChunks.add(chunkIndex);
        } catch {
          // Decrypt failed — corrupted or wrong key; skip this chunk (will be re-requested)
        }
      }
      emit('fileChunk', transferId, fileBuf.receivedChunks.size, fileBuf.totalChunks, fileBuf.size);
    }
  }

  function setConnectTimeout(reject, errMsg) {
    clearConnectTimeout();
    _connectTimer = setTimeout(() => {
      emit('error', errMsg);
      if (reject) reject(new Error(errMsg));
    }, CONNECT_TIMEOUT);
  }

  function clearConnectTimeout() {
    if (_connectTimer) {
      clearTimeout(_connectTimer);
      _connectTimer = null;
    }
  }

  async function connect(token) {
    _isHost = false;
    _connections = [];
    _fileBuffers.clear();
    const hostPeerId = await hashToken(token);

    return new Promise((resolve, reject) => {
      emit('connState', 'connecting');

      _peer = createPeer(hostPeerId);

      _peer.on('open', (id) => {
        _myPeerId = id;
        _isHost = true;
        emit('connState', 'waiting');
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
          emit('connState', 'failed');
          emit('error', 'Room not found. Make sure the host has created the room first.');
          reject(err);
        } else if (err.type === 'network' || err.type === 'server-error') {
          emit('connState', 'reconnecting');
          emit('status', 'Signaling server error. Retrying...');
          // PeerJS auto-reconnects, but we track the state
        } else {
          emit('connState', 'failed');
          emit('error', `PeerJS error: ${err.type} - ${err.message}`);
          reject(err);
        }
      });

      _peer.on('disconnected', () => {
        emit('connState', 'reconnecting');
        emit('status', 'Disconnected from signaling server. Reconnecting...');
        if (_peer) {
          try { _peer.reconnect(); } catch {}
        }
      });
    });
  }

  function joinExistingWithRetry(hostPeerId, attempt) {
    return new Promise((resolve, reject) => {
      const myId = hostPeerId + '-' + Math.random().toString(36).slice(2, 8);

      if (attempt === 0) {
        emit('connState', 'connecting');
        emit('status', 'Connecting to room...');
      } else {
        emit('connState', 'connecting');
        emit('status', `Retrying connection (${attempt + 1}/${MAX_JOIN_RETRIES})...`);
      }

      _peer = createPeer(myId);

      // Timeout for this attempt
      const attemptTimer = setTimeout(() => {
        emit('status', 'Connection attempt timed out. Retrying...');
        if (_peer) { _peer.destroy(); _peer = null; }
        if (attempt < MAX_JOIN_RETRIES) {
          setTimeout(() => {
            joinExistingWithRetry(hostPeerId, attempt + 1).then(resolve).catch(reject);
          }, JOIN_RETRY_DELAY);
        } else {
          emit('connState', 'failed');
          reject(new Error('Connection timeout'));
        }
      }, CONNECT_TIMEOUT);

      _peer.on('open', () => {
        _myPeerId = myId;
        _isHost = false;
        const conn = _peer.connect(hostPeerId, { reliable: true });

        conn.on('open', () => {
          clearTimeout(attemptTimer);
          setupConnection(conn);
          emit('status', 'Connected to room.');
          resolve({ peerId: myId, isHost: false });
        });

        conn.on('error', (err) => {
          clearTimeout(attemptTimer);
          if (attempt < MAX_JOIN_RETRIES) {
            if (_peer) { _peer.destroy(); _peer = null; }
            setTimeout(() => {
              joinExistingWithRetry(hostPeerId, attempt + 1).then(resolve).catch(reject);
            }, JOIN_RETRY_DELAY);
          } else {
            emit('connState', 'failed');
            emit('error', `Failed to connect after ${MAX_JOIN_RETRIES} attempts.`);
            reject(err);
          }
        });
      });

      _peer.on('connection', (conn) => {
        setupConnection(conn);
      });

      _peer.on('error', (err) => {
        clearTimeout(attemptTimer);
        if (err.type === 'unavailable-id') {
          // My random ID taken (unlikely), retry with new ID
          if (_peer) { _peer.destroy(); _peer = null; }
          setTimeout(() => {
            joinExistingWithRetry(hostPeerId, attempt + 1).then(resolve).catch(reject);
          }, 500);
        } else if (attempt < MAX_JOIN_RETRIES) {
          if (_peer) { _peer.destroy(); _peer = null; }
          setTimeout(() => {
            joinExistingWithRetry(hostPeerId, attempt + 1).then(resolve).catch(reject);
          }, JOIN_RETRY_DELAY);
        } else {
          emit('connState', 'failed');
          emit('error', `PeerJS error: ${err.type} - ${err.message}`);
          reject(err);
        }
      });

      _peer.on('disconnected', () => {
        emit('connState', 'reconnecting');
        if (_peer) {
          try { _peer.reconnect(); } catch {}
        }
      });
    });
  }

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

  function sendPing() {
    const id = crypto.getRandomValues(new Uint8Array(8))
      .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    const t = Date.now();
    broadcast(JSON.stringify({ type: 'ping', id, t }), null);
    return { id, t };
  }

  async function _sendChunksToPeer(conn, transferId, indices) {
    const t = _outgoingTransfers.get(transferId);
    if (!t) return;

    const list = indices || Array.from({ length: t.totalChunks }, (_, i) => i);

    for (let i = 0; i < list.length; i++) {
      const idx = list[i];
      if (idx < 0 || idx >= t.totalChunks) continue;
      const chunk = t.chunks[idx];
      if (!chunk) continue; // skip if chunk somehow missing
      const packet = packChunk(transferId, idx, chunk);
      if (conn.open) conn.send(packet);
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    // Send fileEnd only to this specific connection
    if (conn.open) conn.send(JSON.stringify({ type: 'fileEnd', transferId }));
  }

  async function sendFile(file) {
    const transferId = crypto.getRandomValues(new Uint8Array(16))
      .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Broadcast metadata so peers can prepare buffers
    broadcast(JSON.stringify({
      type: 'fileMeta',
      transferId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks
    }), null);

    // Per-chunk encryption and keep chunks in memory for resend
    const buffer = await file.arrayBuffer();
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
      const plainChunk = new Uint8Array(buffer.slice(start, end));
      const encryptedChunk = await Crypto.encryptBytes(plainChunk);
      chunks.push(encryptedChunk);
    }

    _outgoingTransfers.set(transferId, {
      transferId,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      totalChunks,
      chunks,
      timer: setTimeout(() => {
        _outgoingTransfers.delete(transferId);
      }, OUTGOING_TRANSFER_TTL)
    });

    // Start sending to all currently connected peers
    for (const conn of _connections) {
      if (conn.open) _sendChunksToPeer(conn, transferId);
    }

    return transferId;
  }

  function requestResend(transferId, missingIndices) {
    if (!missingIndices || missingIndices.length === 0) return;
    broadcast(JSON.stringify({
      type: 'fileResend',
      transferId,
      missing: missingIndices
    }), null);
  }

  function getFileProgress(transferId) {
    const buf = _fileBuffers.get(transferId);
    if (!buf) return null;
    return {
      transferId,
      name: buf.name,
      size: buf.size,
      type: buf.type,
      totalChunks: buf.totalChunks,
      receivedChunks: Array.from(buf.receivedChunks),
      // Preserve sparse array structure (null = missing chunk)
      chunks: buf.chunks.map(c => c || null)
    };
  }

  function restoreFileBuffer(transferId, meta, chunks, receivedChunks) {
    if (_fileBuffers.has(transferId)) return;
    _fileBuffers.set(transferId, {
      name: meta.name,
      size: meta.size,
      type: meta.type,
      totalChunks: meta.totalChunks,
      chunks: chunks.slice(),
      receivedChunks: new Set(receivedChunks)
    });
  }

  function getPeerCount() {
    return _connections.filter(c => c.open).length;
  }

  function disconnect() {
    clearConnectTimeout();
    for (const conn of _connections) {
      conn.close();
    }
    _connections = [];
    _fileBuffers.clear();
    for (const [, t] of _outgoingTransfers) {
      clearTimeout(t.timer);
    }
    _outgoingTransfers.clear();
    if (_peer) {
      _peer.destroy();
      _peer = null;
    }
    _isHost = false;
    _myPeerId = null;
  }

  return {
    connect, sendMessage, sendPing, sendFile, disconnect,
    on, getPeerCount, hashToken,
    requestResend, getFileProgress, restoreFileBuffer
  };
})();
