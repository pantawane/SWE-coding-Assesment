# Private notes protocol

A workspace member generates a random 256-bit AES key in their browser and shares its encoded value with authorized workspace members through a trusted channel. Each member imports it as a non-extractable Web Crypto key. The app holds the key in browser memory for the open thread. Reloading or closing the thread clears it. Agents keep a copy in a workspace password manager and re-enter it when needed.

The browser encrypts each note with AES-GCM using a fresh random 96-bit nonce. The authenticated data binds the ciphertext to the protocol version, workspace, and contact. The server stores the ciphertext and nonce along with workspace, contact, author, and timestamp metadata. Tenant membership controls access to those records. Anyone with the key and ciphertext can decrypt the note. Lost keys cannot be recovered from the server.

The protocol does not protect against these attacks.

1. A compromised browser, malicious extension, or tampered application script can read the key or plaintext.
2. A member who exports the key or earlier plaintext keeps that access after removal from the workspace. The prototype has no key rotation or revocation workflow.
3. A server that controls storage can delete or replay encrypted records. It can also observe which members write notes, when they write them, and their approximate length. The external author field is not an end-to-end signature.
