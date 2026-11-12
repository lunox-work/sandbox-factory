# Slice boundary

Source commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (snapshot `rsn_1`), graph run `arn_graph`.

Entry points: `scripts/tool.py`. Budget: 1 files, depth 1.

Declaration coverage: **names-only**. Diagnostic only: this slice cannot be published.

## Blockers

- Declaration coverage is names-only.
- missing_build_input in scripts/tool.py: boto3 is imported but no package.json pins its version.
- no_extractor: Signature extraction exists for TypeScript and JavaScript only.

## Included files

- `scripts/tool.py` (112 bytes, blob b136974390224f0a331429edb4601dda6a00bdda)

## Stubbed modules

What the slice imports from outside, as declarations without bodies.

### `scripts/helper.py`

Imported by: `scripts/tool.py`


## Public surface

What outside code imports from the slice; a contribution must keep these.

Nothing outside the slice imports it.
## Externals to mock

- `boto3` (aws) in `scripts/tool.py`
- `BUCKET` read in `scripts/tool.py`

## Compilation

No compilation was attempted for this language.
