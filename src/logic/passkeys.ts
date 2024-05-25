import { Buffer } from "buffer";
import { ethers } from "ethers";

type PasskeyCredential = {
	id: "string";
	rawId: ArrayBuffer;
	response: {
		clientDataJSON: ArrayBuffer;
		attestationObject: ArrayBuffer;
		getPublicKey(): ArrayBuffer;
	};
	type: "public-key";
  extensions: AuthenticationExtensionsClientInputsExtended,
};

type PasskeyCredentialWithPubkeyCoordinates = PasskeyCredential & {
	pubkeyCoordinates: {
		x: bigint;
		y: bigint;
	};
};

const firstSalt = new Uint8Array(new Array(32).fill(1)).buffer;

interface AuthenticationExtensionsLargeBlobInputs {
	read?: boolean;
	support?: "required" | "preferred";
	write?: BufferSource;
}

interface AuthenticationExtensionsPRFValues {
	first: BufferSource;
	second?: BufferSource;
}

interface AuthenticationExtensionsPRFValues {
	first: BufferSource;
	second?: BufferSource;
}

interface AuthenticationExtensionsPRFInputs {
	eval: AuthenticationExtensionsPRFValues;
	evalByCredential?: Record<string, AuthenticationExtensionsPRFValues>;
}

interface AuthenticationExtensionsClientInputsExtended
	extends AuthenticationExtensionsClientInputs {
	largeBlob?: AuthenticationExtensionsLargeBlobInputs;
	prf?: AuthenticationExtensionsPRFInputs;
}
/**
 * Creates a passkey for signing.
 *
 * @returns A promise that resolves to a PasskeyCredentialWithPubkeyCoordinates object, which includes the passkey credential information and its public key coordinates.
 * @throws Throws an error if the passkey generation fails or if the credential received is null.
 */
async function createPasskey(): Promise<PasskeyCredentialWithPubkeyCoordinates> {
  // Generate a passkey credential using WebAuthn API
  const passkeyCredential = (await navigator.credentials.create({
    publicKey: {
      pubKeyCredParams: [
        {
          // ECDSA w/ SHA-256: https://datatracker.ietf.org/doc/html/rfc8152#section-8.1
          alg: -7,
          type: 'public-key',
        },
      ],
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: {
        name: 'Safe Wallet',
      },
      user: {
        displayName: 'Safe Owner',
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: 'safe-owner',
      },
      timeout: 60000,
      attestation: 'none',
      extensions: {
        largeBlob: {
          support: "preferred",  // Or "required".
        },
      } as AuthenticationExtensionsClientInputsExtended
    },
  }))as any;

	if (!passkeyCredential) {
		throw new Error(
			"Failed to generate passkey. Received null as a credential",
		);
	}

	console.log(passkeyCredential.getClientExtensionResults(), "response");

	// Import the public key to later export it to get the XY coordinates
	const key = await crypto.subtle.importKey(
		"spki",
		passkeyCredential.response.getPublicKey(),
		{
			name: "ECDSA",
			namedCurve: "P-256",
			hash: { name: "SHA-256" },
		},
		true, // boolean that marks the key as an exportable one
		["verify"],
	);

	// Export the public key in JWK format and extract XY coordinates
	const exportedKeyWithXYCoordinates = await crypto.subtle.exportKey(
		"jwk",
		key,
	);
	if (!exportedKeyWithXYCoordinates.x || !exportedKeyWithXYCoordinates.y) {
		throw new Error("Failed to retrieve x and y coordinates");
	}

	// Create a PasskeyCredentialWithPubkeyCoordinates object
	const passkeyWithCoordinates: PasskeyCredentialWithPubkeyCoordinates =
		Object.assign(passkeyCredential, {
			pubkeyCoordinates: {
				x: BigInt(
					"0x" +
						Buffer.from(exportedKeyWithXYCoordinates.x, "base64").toString(
							"hex",
						),
				),
				y: BigInt(
					"0x" +
						Buffer.from(exportedKeyWithXYCoordinates.y, "base64").toString(
							"hex",
						),
				),
			},
		});

	return passkeyWithCoordinates;
}

export type PasskeyLocalStorageFormat = {
	rawId: string;
	pubkeyCoordinates: {
		x: bigint;
		y: bigint;
	};
};

/**
 * Converts a PasskeyCredentialWithPubkeyCoordinates object to a format that can be stored in the local storage.
 * The rawId is required for signing and pubkey coordinates are for our convenience.
 * @param passkey - The passkey to be converted.
 * @returns The passkey in a format that can be stored in the local storage.
 */
function toLocalStorageFormat(
	passkey: PasskeyCredentialWithPubkeyCoordinates,
): PasskeyLocalStorageFormat {
	return {
		rawId: Buffer.from(passkey.rawId).toString("hex"),
		pubkeyCoordinates: passkey.pubkeyCoordinates,
	};
}

/**
 * Checks if the provided value is in the format of a Local Storage Passkey.
 * @param x The value to check.
 * @returns A boolean indicating whether the value is in the format of a Local Storage Passkey.
 */
function isLocalStoragePasskey(x: unknown): x is PasskeyLocalStorageFormat {
	return (
		typeof x === "object" &&
		x !== null &&
		"rawId" in x &&
		"pubkeyCoordinates" in x
	);
}

/**
 * Extracts the signature into R and S values from the authenticator response.
 *
 * See:
 * - <https://datatracker.ietf.org/doc/html/rfc3279#section-2.2.3>
 * - <https://en.wikipedia.org/wiki/X.690#BER_encoding>
 */
function extractSignature(
	signature: ArrayBuffer | Uint8Array,
): [bigint, bigint] {
	let sig: ArrayBuffer;
	if (signature instanceof Uint8Array) {
		sig = signature.buffer;
	} else {
		sig = signature;
	}

	const check = (x: boolean) => {
		if (!x) {
			throw new Error("invalid signature encoding");
		}
	};

	// Decode the DER signature. Note that we assume that all lengths fit into 8-bit integers,
	// which is true for the kinds of signatures we are decoding but generally false. I.e. this
	// code should not be used in any serious application.
	const view = new DataView(sig);

	// check that the sequence header is valid
	check(view.getUint8(0) === 0x30);
	check(view.getUint8(1) === view.byteLength - 2);

	// read r and s
	const readInt = (offset: number) => {
		check(view.getUint8(offset) === 0x02);
		const len = view.getUint8(offset + 1);
		const start = offset + 2;
		const end = start + len;
		const n = BigInt(
			ethers.hexlify(new Uint8Array(view.buffer.slice(start, end))),
		);
		check(n < ethers.MaxUint256);
		return [n, end] as const;
	};
	const [r, sOffset] = readInt(2);
	const [s] = readInt(sOffset);

	return [r, s];
}

/**
 * Compute the additional client data JSON fields. This is the fields other than `type` and
 * `challenge` (including `origin` and any other additional client data fields that may be
 * added by the authenticator).
 *
 * See <https://w3c.github.io/webauthn/#clientdatajson-serialization>
 */
function extractClientDataFields(
	response: AuthenticatorAssertionResponse,
): string {
	const clientDataJSON = new TextDecoder("utf-8").decode(
		response.clientDataJSON,
	);
	const match = clientDataJSON.match(
		/^\{"type":"webauthn.get","challenge":"[A-Za-z0-9\-_]{43}",(.*)\}$/,
	);

	if (!match) {
		throw new Error("challenge not found in client data JSON");
	}

	const [, fields] = match;
	return ethers.hexlify(ethers.toUtf8Bytes(fields));
}

export {
	createPasskey,
	toLocalStorageFormat,
	isLocalStoragePasskey,
	extractSignature,
	extractClientDataFields,
};
