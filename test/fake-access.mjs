// Fake Cloudflare Access issuer for the auth test.
//
// - Generates an RS256 keypair, serves its JWKS at /cdn-cgi/access/certs.
// - Writes tokens into OUT_DIR: good, forged (other key), wrong-aud, wrong-email.
// - Touches OUT_DIR/ready once listening.
//
// Env: PORT (8788), OUT_DIR (required), AUD, EMAIL
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const PORT = Number(process.env.PORT ?? 8788);
const OUT = process.env.OUT_DIR;
const AUD = process.env.AUD ?? "test-aud";
const EMAIL = process.env.EMAIL ?? "owner@example.com";
const ISS = `http://127.0.0.1:${PORT}`;
if (!OUT) throw new Error("OUT_DIR is required");

const kid = "test-key";
const real = await generateKeyPair("RS256", { extractable: true });
const rogue = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(real.publicKey)), kid, alg: "RS256", use: "sig" };

function sign(key, { aud = AUD, email = EMAIL } = {}) {
  return new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISS)
    .setAudience(aud)
    .setSubject("test-user")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

const tokens = {
  good: await sign(real.privateKey),
  forged: await sign(rogue.privateKey),
  "wrong-aud": await sign(real.privateKey, { aud: "some-other-app" }),
  "wrong-email": await sign(real.privateKey, { email: "intruder@example.com" }),
};
for (const [name, t] of Object.entries(tokens)) writeFileSync(join(OUT, `${name}.jwt`), t);

createServer((req, res) => {
  if (req.url === "/cdn-cgi/access/certs") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk], public_cert: { kid }, public_certs: [] }));
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, "127.0.0.1", () => {
  writeFileSync(join(OUT, "ready"), ISS);
  console.log(`fake access issuer on ${ISS}`);
});
