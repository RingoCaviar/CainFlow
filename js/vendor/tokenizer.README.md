# Offline tokenizer

`tokenizer.js` bundles gpt-tokenizer 4.1.0 (MIT, see tokenizer.LICENSE), using only
o200k_base and cl100k_base counting exports. No CDN or runtime network access.
Upstream: https://github.com/niieani/gpt-tokenizer

Rebuild from repository root (Node/npm required):

```powershell
npm install --prefix .scratch/tokenizer-build gpt-tokenizer@4.1.0 esbuild@0.25.12 --no-audit --no-fund
@'
export { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';
export { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
'@ | Set-Content .scratch/tokenizer-build/entry.js
.scratch/tokenizer-build/node_modules/.bin/esbuild.cmd .scratch/tokenizer-build/entry.js --bundle --format=esm --minify --charset=utf8 --supported:template-literal=false --outfile=js/vendor/tokenizer.js
Copy-Item .scratch/tokenizer-build/node_modules/gpt-tokenizer/LICENSE js/vendor/tokenizer.LICENSE
```

Message framing and multimodal handling remain application estimates; these
encodings do not establish tokenizer compatibility for arbitrary proxy models.
