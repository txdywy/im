/**
 * End-to-end encryption module using Web Crypto API
 * - PBKDF2 key derivation from shared token
 * - AES-256-GCM encryption/decryption
 */

const Crypto = (() => {
  const SALT = new TextEncoder().encode('im-p2p-e2ee-salt-v1');
  const ITERATIONS = 100000;

  let _key = null;

  async function deriveKey(token) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(token), 'PBKDF2', false, ['deriveKey']
    );
    _key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return _key;
  }

  function getKey() {
    if (!_key) throw new Error('Encryption key not initialized. Call deriveKey first.');
    return _key;
  }

  async function encrypt(plaintext) {
    const key = getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
    );
    // Pack iv + ciphertext into single Uint8Array
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result;
  }

  async function decrypt(data) {
    const key = getKey();
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ciphertext
    );
    return new TextDecoder().decode(decrypted);
  }

  async function encryptBytes(bytes) {
    const key = getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, bytes
    );
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result;
  }

  async function decryptBytes(data) {
    const key = getKey();
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ciphertext
    ));
  }

  // Generate a fingerprint of the derived key for visual verification
  async function getKeyFingerprint() {
    const key = getKey();
    const raw = await crypto.subtle.exportKey('raw', key);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const hex = Array.from(new Uint8Array(hash.slice(0, 4)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{1,4}/g).join(' ');
  }

  return { deriveKey, encrypt, decrypt, encryptBytes, decryptBytes, getKeyFingerprint };
})();
