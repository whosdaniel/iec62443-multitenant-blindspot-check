# Vendored runtime dependencies

Files in this directory are third-party code bundled for offline execution.
BlindSpotCheck never fetches runtime code from the network - every dependency
needed by the canvas UI lives here.

## cytoscape.min.js

- **Project**: [Cytoscape.js](https://js.cytoscape.org/)
- **Version**: 3.33.2
- **License**: MIT (see `LICENSE.cytoscape` alongside)
- **Source**: `https://cdn.jsdelivr.net/npm/cytoscape@3.33.2/dist/cytoscape.min.js`
- **Size**: 434,107 bytes
- **SHA-256**: `f75bb1eb6f4175334a6af069a75f6a031510091b9bbcb08a73fc9ec475743c6d`

Verified clean of known CVEs on 2026-04-18 via
`https://api.osv.dev/v1/query` (empty response, no advisories).
Runtime dependencies of `cytoscape@3.33.2` on npm: none.

### Refresh procedure

To refresh to a new upstream version, verify CVE status at osv.dev first,
then:

```sh
cd web/vendor
curl -sS -L -o cytoscape.min.js \
  "https://cdn.jsdelivr.net/npm/cytoscape@<VERSION>/dist/cytoscape.min.js"
curl -sS -L -o LICENSE.cytoscape \
  "https://raw.githubusercontent.com/cytoscape/cytoscape.js/v<VERSION>/LICENSE"
shasum -a 256 cytoscape.min.js
```

Paste the new SHA-256 into the section above, bump the version, commit.

### CSP style hash

`web/index.html` pins a SHA-256 for the one `<style>` element Cytoscape
injects at runtime (the constant `.__________cytoscape_container
{ position: relative; }`). On a version bump, confirm the constant still
matches and recompute the hash:

```sh
grep -oE 'textContent="[^"]+"' web/vendor/cytoscape.min.js
printf '%s' '.__________cytoscape_container { position: relative; }' \
  | openssl dgst -sha256 -binary | openssl base64
```

If the upstream string changes, paste the new value into the
`style-src-elem` directive in `web/index.html`.
