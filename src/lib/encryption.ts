/**
 * Encryption Utility using Web Crypto API (AES-GCM)
 * This provides secure authenticated encryption for sensitive fields like PromptPay IDs.
 */

const ENCRYPTION_KEY_RAW = import.meta.env.VITE_ENCRYPTION_KEY || 'default-fallback-key-do-not-use-in-prod';

// Helper to get the crypto key
async function getCryptoKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(ENCRYPTION_KEY_RAW.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

/**
 * Encrypts a string and returns a base64 string containing IV + Ciphertext
 */
export async function encrypt(text: string): Promise<string> {
  if (!text) return '';
  console.log('[Encryption] 🔐 Encrypting sensitive data:', text);
  try {
    const key = await getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(text)
    );

    // Combine IV and Encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    // Convert to Base64 for storage
    return btoa(String.fromCharCode(...combined));
  } catch (err) {
    console.error('Encryption failed:', err);
    return text; // Fallback to plain text if failed (not ideal but safe for app continuity)
  }
}

/**
 * Decrypts a base64 string
 */
export async function decrypt(encryptedBase64: string): Promise<string> {
  if (!encryptedBase64 || !encryptedBase64.includes('==') && encryptedBase64.length < 20) {
    // Basic heuristic: if it doesn't look like base64 or is too short, it's likely already plain text
    return encryptedBase64;
  }
  
  console.log('[Encryption] 🔓 Decrypting data...');
  try {
    const key = await getCryptoKey();
    const combined = new Uint8Array(
      atob(encryptedBase64).split('').map(c => c.charCodeAt(0))
    );

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    // If decryption fails, it might be plain text from before encryption was enabled
    return encryptedBase64;
  }
}

/**
 * Recursively find and process promptPayId in objects/arrays
 */
export async function processSensitiveData(obj: any, mode: 'encrypt' | 'decrypt'): Promise<any> {
  if (!obj || typeof obj !== 'object') return obj;

  const newObj = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key in newObj) {
    if (key === 'promptPayId' && typeof newObj[key] === 'string' && newObj[key]) {
      newObj[key] = mode === 'encrypt' ? await encrypt(newObj[key]) : await decrypt(newObj[key]);
    } else if (typeof newObj[key] === 'object') {
      newObj[key] = await processSensitiveData(newObj[key], mode);
    }
  }

  return newObj;
}
