/**
 * Main application logic - UI management and coordination
 */

const App = (() => {
  // DOM elements
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // State
  let _token = '';
  let _nickname = '';
  let _connected = false;

  function init() {
    // Check URL for room token
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('room');
    if (urlToken) {
      $('#tokenInput').value = urlToken;
    }

    // Check for stored nickname
    const stored = localStorage.getItem('im-nickname');
    if (stored) $('#nicknameInput').value = stored;

    bindEvents();
    generateQR();

    // Update QR when token changes
    $('#tokenInput').addEventListener('input', debounce(generateQR, 300));
  }

  function bindEvents() {
    $('#joinBtn').addEventListener('click', joinRoom);
    $('#generateBtn').addEventListener('click', generateToken);
    $('#sendBtn').addEventListener('click', sendMessage);
    $('#messageInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('#fileInput').addEventListener('change', handleFileSelect);
    $('#leaveBtn').addEventListener('click', leaveRoom);
    $('#copyTokenBtn').addEventListener('click', copyToken);
    $('#copyLinkBtn').addEventListener('click', copyLink);

    // Drag and drop
    const dropZone = $('#dropZone');
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      for (const file of e.dataTransfer.files) {
        sendFile(file);
      }
    });

    // Auto-resize textarea
    const ta = $('#messageInput');
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    });
  }

  function generateToken() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const rand = new Uint8Array(12);
    crypto.getRandomValues(rand);
    const segments = [];
    for (let s = 0; s < 3; s++) {
      let seg = '';
      for (let i = 0; i < 4; i++) {
        seg += chars[rand[s * 4 + i] % chars.length];
      }
      segments.push(seg);
    }
    const token = segments.join('-');
    $('#tokenInput').value = token;
    generateQR();
    return token;
  }

  async function generateQR() {
    const token = $('#tokenInput').value.trim();
    const canvas = $('#qrCanvas');
    const qrSection = $('#qrSection');

    if (!token) {
      qrSection.style.display = 'none';
      return;
    }

    qrSection.style.display = 'block';
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(token)}`;

    try {
      await QRCode.toCanvas(canvas, url, {
        width: 200,
        margin: 2,
        color: { dark: '#e2e8f0', light: '#1e293b' }
      });
    } catch {
      // Fallback: show URL as text
      const ctx = canvas.getContext('2d');
      canvas.width = 200;
      canvas.height = 60;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, 200, 60);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px monospace';
      ctx.fillText(url.slice(0, 30), 10, 30);
    }
  }

  async function joinRoom() {
    _token = $('#tokenInput').value.trim();
    _nickname = $('#nicknameInput').value.trim() || 'Anonymous';

    if (!_token) {
      showStatus('Please enter a room token', 'error');
      return;
    }

    localStorage.setItem('im-nickname', _nickname);

    // Derive encryption key from token
    showStatus('Initializing encryption...');
    await Crypto.deriveKey(_token);

    // Update URL
    const url = new URL(window.location);
    url.searchParams.set('room', _token);
    window.history.replaceState({}, '', url);

    // Switch to chat view
    $('#joinScreen').classList.add('hidden');
    $('#chatScreen').classList.remove('hidden');
    $('#roomToken').textContent = _token;

    // Show key fingerprint for verification
    try {
      const fp = await Crypto.getKeyFingerprint();
      $('#keyFingerprint').textContent = fp;
    } catch {}

    // Setup P2P event handlers
    P2P.on('message', handleIncomingMessage);
    P2P.on('peerJoin', handlePeerJoin);
    P2P.on('peerLeave', handlePeerLeave);
    P2P.on('fileMeta', handleFileMeta);
    P2P.on('fileChunk', handleFileChunk);
    P2P.on('fileComplete', handleFileComplete);
    P2P.on('status', (msg) => addSystemMessage(msg));
    P2P.on('error', (msg) => addSystemMessage(msg, 'error'));

    // Connect
    try {
      showStatus('Connecting...');
      await P2P.connect(_token);
      _connected = true;
      $('#messageInput').focus();
    } catch (err) {
      addSystemMessage('Failed to connect. Is the room host online?', 'error');
    }
  }

  function leaveRoom() {
    P2P.disconnect();
    _connected = false;
    $('#chatScreen').classList.add('hidden');
    $('#joinScreen').classList.remove('hidden');
    $('#messages').innerHTML = '';
    addSystemMessage('Disconnected from room.');
  }

  // Safe base64 encode/decode without spread operator (avoids stack overflow on large data)
  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function sendMessage() {
    const input = $('#messageInput');
    const text = input.value.trim();
    if (!text || !_connected) return;

    input.value = '';
    input.style.height = 'auto';

    // Encrypt and send
    try {
      const encrypted = await Crypto.encrypt(text);
      const b64 = bytesToBase64(encrypted);
      P2P.sendMessage(b64);

      // Display locally
      addChatMessage(text, _nickname, true);
    } catch (err) {
      addSystemMessage(`Encryption error: ${err.message}`, 'error');
    }
  }

  async function handleIncomingMessage(payload, peerId) {
    try {
      const bytes = base64ToBytes(payload);
      const decrypted = await Crypto.decrypt(bytes);
      addChatMessage(decrypted, peerId.slice(0, 8), false);
    } catch {
      addChatMessage('[decryption failed]', peerId.slice(0, 8), false);
    }
  }

  function handlePeerJoin(peerId, count) {
    updatePeerCount(count);
    addSystemMessage(`Peer joined (${count} total)`);
  }

  function handlePeerLeave(peerId, count) {
    updatePeerCount(count);
    addSystemMessage(`Peer left (${count} total)`);
  }

  function updatePeerCount(count) {
    $('#peerCount').textContent = `${count} peer${count !== 1 ? 's' : ''}`;
  }

  // File transfer
  async function handleFileSelect(e) {
    for (const file of e.target.files) {
      await sendFile(file);
    }
    e.target.value = '';
  }

  async function sendFile(file) {
    if (!_connected) {
      addSystemMessage('Not connected.', 'error');
      return;
    }

    if (file.size > 100 * 1024 * 1024) {
      addSystemMessage(`File too large: ${file.name} (max 100MB)`, 'error');
      return;
    }

    addSystemMessage(`Encrypting and sending: ${file.name} (${formatSize(file.size)})...`);
    try {
      const raw = new Uint8Array(await file.arrayBuffer());
      const encrypted = await Crypto.encryptBytes(raw);
      // Wrap encrypted bytes as a File for P2P.sendFile
      const encFile = new File([encrypted], file.name, { type: 'application/octet-stream' });
      await P2P.sendFile(encFile);
      addSystemMessage(`Sent: ${file.name}`);
    } catch (err) {
      addSystemMessage(`Failed to send ${file.name}: ${err.message}`, 'error');
    }
  }

  function handleFileMeta(meta) {
    addSystemMessage(`Receiving: ${meta.name} (${formatSize(meta.size)})...`);
  }

  function handleFileChunk(transferId, received, total, size) {
    const pct = Math.round((received / total) * 100);
    // Update or create progress indicator
    let el = $(`#progress-${transferId}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `progress-${transferId}`;
      el.className = 'transfer-progress';
      el.innerHTML = `<div class="progress-bar"><div class="progress-fill"></div></div><span class="progress-text">0%</span>`;
      $('#messages').appendChild(el);
      scrollToBottom();
    }
    el.querySelector('.progress-fill').style.width = `${pct}%`;
    el.querySelector('.progress-text').textContent = `${pct}% (${formatSize(Math.round(size * received / total))}/${formatSize(size)})`;
    scrollToBottom();
  }

  async function handleFileComplete(transferId, blob, name, size) {
    // Remove progress indicator
    const el = $(`#progress-${transferId}`);
    if (el) el.remove();

    // Decrypt the file
    try {
      const encrypted = new Uint8Array(await blob.arrayBuffer());
      const decrypted = await Crypto.decryptBytes(encrypted);
      const decryptedBlob = new Blob([decrypted]);
      addFileMessage(name, size, decryptedBlob);
    } catch (err) {
      addSystemMessage(`Failed to decrypt file: ${name}`, 'error');
    }
  }

  // UI helpers
  function addChatMessage(text, sender, isSelf) {
    const div = document.createElement('div');
    div.className = `message ${isSelf ? 'self' : 'other'}`;
    div.innerHTML = `
      <span class="sender">${escapeHtml(isSelf ? 'You' : sender)}</span>
      <div class="bubble">${escapeHtml(text)}</div>
      <span class="time">${new Date().toLocaleTimeString()}</span>
    `;
    $('#messages').appendChild(div);
    scrollToBottom();
  }

  function addFileMessage(name, size, blob) {
    const div = document.createElement('div');
    div.className = 'message other file-msg';
    const url = URL.createObjectURL(blob);
    const ext = name.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext);

    div.innerHTML = `
      <div class="bubble file-bubble">
        ${isImage ? `<img src="${url}" class="file-preview" alt="${escapeHtml(name)}">` : ''}
        <div class="file-info">
          <span class="file-name">${escapeHtml(name)}</span>
          <span class="file-size">${formatSize(size)}</span>
        </div>
        <a href="${url}" download="${escapeHtml(name)}" class="download-btn">Download</a>
      </div>
      <span class="time">${new Date().toLocaleTimeString()}</span>
    `;
    $('#messages').appendChild(div);
    scrollToBottom();
  }

  function addSystemMessage(text, type = 'info') {
    const div = document.createElement('div');
    div.className = `system-msg ${type}`;
    div.textContent = text;
    $('#messages').appendChild(div);
    scrollToBottom();
  }

  function showStatus(text, type = 'info') {
    const el = $('#joinStatus');
    el.textContent = text;
    el.className = `status ${type}`;
  }

  function scrollToBottom() {
    const container = $('#messages');
    container.scrollTop = container.scrollHeight;
  }

  function copyToken() {
    const token = $('#roomToken').textContent;
    navigator.clipboard.writeText(token).then(() => {
      const btn = $('#copyTokenBtn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  }

  function copyLink() {
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(_token)}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = $('#copyLinkBtn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy Link', 1500);
    });
  }

  // Utilities
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
