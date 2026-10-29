import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { pathToFileURL } from "node:url";

export function ephemeralSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const key = Buffer.from(
    `untrusted comment: disposable updater fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`,
  ).toString("base64");
  return {
    publicKey: key,
    sign(bytes, version) {
      const signature = sign(
        null,
        createHash("blake2b512").update(bytes).digest(),
        privateKey,
      );
      const trusted = `timestamp:1\tfile:fixture${version === null ? "" : `\tversion:${version}`}`;
      const global = sign(
        null,
        Buffer.concat([signature, Buffer.from(trusted)]),
        privateKey,
      );
      return Buffer.from(
        `untrusted comment: disposable updater fixture\n${Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`,
      ).toString("base64");
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const signer = ephemeralSigner();
  const bytes = Buffer.from("disposable signed updater fixture");
  process.stdout.write(
    JSON.stringify({
      publicKey: signer.publicKey,
      payload: bytes.toString(),
      signature: signer.sign(bytes, "0.2.0"),
      absentVersion: signer.sign(bytes, null),
      mismatchedVersion: signer.sign(bytes, "0.1.9"),
      wrongKey: ephemeralSigner().sign(bytes, "0.2.0"),
    }),
  );
}
