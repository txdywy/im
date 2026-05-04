/**
 * Main application logic - UI management and coordination
 */

const App = (() => {
  const $ = (sel) => document.querySelector(sel);

  let _token = '';
  let _nickname = '';
  let _connected = false;
  let _blobUrls = [];

  function init() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('room');
    if (urlToken) {
      $('#tokenInput').value = urlToken;
    }

    const stored = localStorage.getItem('im-nickname');
    if (stored) $('#nicknameInput').value = stored;

    bindEvents();
    generateQR();
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
    $('#copyLinkBtn').addEventListener('click', copyLink);

    // Share panel
    $('#sharePanelBtn').addEventListener('click', toggleSharePanel);
    $('#shareCopyToken').addEventListener('click', () => copyToClipboard(_token, '#shareCopyToken'));
    $('#shareCopyLink').addEventListener('click', () => copyToClipboard(getShareUrl(), '#shareCopyLink'));
    $('#shareNativeBtn').addEventListener('click', nativeShare);

    // Drag and drop (desktop)
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
      ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
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
    const url = getShareUrlForToken(token);

    try {
      await QRCode.toCanvas(canvas, url, {
        width: 200,
        margin: 2,
        color: { dark: '#e2e8f0', light: '#1e293b' }
      });
    } catch {
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

  function getShareUrl() {
    return getShareUrlForToken(_token);
  }

  function getShareUrlForToken(token) {
    return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(token)}`;
  }

  // --- Share Panel ---

  function toggleSharePanel() {
    const panel = $('#sharePanel');
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
      panel.classList.remove('open');
      setTimeout(() => panel.classList.add('hidden'), 300);
    } else {
      panel.classList.remove('hidden');
      // Force reflow
      panel.offsetHeight;
      panel.classList.add('open');
      // Populate share panel
      $('#shareToken').textContent = _token;
      $('#shareLink').textContent = getShareUrl();
      generateShareQR();
      // Show native share button if supported
      if (navigator.share) {
        $('#shareNativeBtn').classList.remove('hidden');
      }
    }
  }

  async function generateShareQR() {
    const canvas = $('#shareQrCanvas');
    try {
      await QRCode.toCanvas(canvas, getShareUrl(), {
        width: 140,
        margin: 1,
        color: { dark: '#e2e8f0', light: '#1e293b' }
      });
    } catch {}
  }

  function copyToClipboard(text, btnSelector) {
    const btn = $(btnSelector);
    const original = btn.textContent;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = original, 1500);
      }).catch(() => fallbackCopy(text, btn, original));
    } else {
      fallbackCopy(text, btn, original);
    }
  }

  function fallbackCopy(text, btn, original) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = original, 1500);
    } catch {
      // Last resort: select the text so user can copy
      prompt('Copy this:', text);
    }
    document.body.removeChild(ta);
  }

  async function nativeShare() {
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: 'IM - Encrypted Chat',
        text: `Join my encrypted chat room: ${_token}`,
        url: getShareUrl()
      });
    } catch {
      // User cancelled or not supported
    }
  }

  // --- Connection Status ---

  function updateConnState(state) {
    const el = $('#connectionStatus');
    el.className = 'conn-status visible';
    switch (state) {
      case 'connecting':
        el.textContent = 'Connecting...';
        el.classList.add('connecting');
        break;
      case 'waiting':
        el.textContent = 'Waiting for peers';
        el.classList.add('connected');
        break;
      case 'connected':
        el.textContent = 'Connected';
        el.classList.add('connected');
        // Auto-hide after 3s
        setTimeout(() => {
          if (_connected && P2P.getPeerCount() > 0) {
            el.classList.remove('visible');
          }
        }, 3000);
        break;
      case 'reconnecting':
        el.textContent = 'Reconnecting...';
        el.classList.add('reconnecting');
        break;
      case 'failed':
        el.textContent = 'Connection failed';
        el.classList.add('failed');
        break;
      default:
        el.classList.remove('visible');
    }
  }

  // --- Room Join/Leave ---

  async function joinRoom() {
    _token = $('#tokenInput').value.trim();
    _nickname = $('#nicknameInput').value.trim() || 'Anonymous';

    if (!_token) {
      showStatus('Please enter a room token', 'error');
      return;
    }

    if (typeof Peer === 'undefined' || window._peerjsFailed) {
      showStatus('Failed to load P2P library. Check your network or try refreshing.', 'error');
      return;
    }

    localStorage.setItem('im-nickname', _nickname);

    showStatus('Initializing encryption...');
    await Crypto.deriveKey(_token);

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('room', _token);
    window.history.replaceState({}, '', url);

    // Switch to chat view
    $('#joinScreen').classList.add('hidden');
    $('#chatScreen').classList.remove('hidden');
    $('#roomToken').textContent = _token;

    // Show key fingerprint
    try {
      const fp = await Crypto.getKeyFingerprint();
      $('#keyFingerprint').textContent = fp;
    } catch {}

    // P2P event handlers
    P2P.on('message', handleIncomingMessage);
    P2P.on('peerJoin', handlePeerJoin);
    P2P.on('peerLeave', handlePeerLeave);
    P2P.on('fileMeta', handleFileMeta);
    P2P.on('fileChunk', handleFileChunk);
    P2P.on('fileComplete', handleFileComplete);
    P2P.on('status', (msg) => addSystemMessage(msg));
    P2P.on('error', (msg) => addSystemMessage(msg, 'error'));
    P2P.on('connState', updateConnState);

    // Connect
    try {
      updateConnState('connecting');
      await P2P.connect(_token);
      _connected = true;
      $('#messageInput').focus();
    } catch {
      addSystemMessage('Connection failed. The room host may be offline or network issues occurred.', 'error');
    }
  }

  function leaveRoom() {
    P2P.disconnect();
    _connected = false;

    // Close share panel
    const panel = $('#sharePanel');
    panel.classList.remove('open');
    panel.classList.add('hidden');

    // Revoke blob URLs to free memory
    for (const url of _blobUrls) URL.revokeObjectURL(url);
    _blobUrls = [];

    $('#connectionStatus').className = 'conn-status';
    $('#chatScreen').classList.add('hidden');
    $('#joinScreen').classList.remove('hidden');
    $('#messages').innerHTML = '';
  }

  // --- Messaging ---

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

    try {
      const encrypted = await Crypto.encrypt(text);
      const b64 = bytesToBase64(encrypted);
      P2P.sendMessage(b64);
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

  // --- File Transfer ---

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

  function handleFileComplete(transferId, blob, name, size) {
    const el = $(`#progress-${transferId}`);
    if (el) el.remove();

    // Chunks are already decrypted per-chunk during transfer
    addFileMessage(name, size, blob);
  }

  // --- UI Helpers ---

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
    _blobUrls.push(url);
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
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  function copyLink() {
    copyToClipboard(getShareUrl(), '#copyLinkBtn');
  }

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
