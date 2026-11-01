# Tools

What's installed for working with images, video and audio, and the
project's own way to do each common job. Sessions read this before
reaching for a tool, so they don't try one the project doesn't have (a
Python library that isn't in the environment, say) before finding the
one it does. A tool only some machines have goes in `docs/machines.md`
(Can) too, with the units that need it pinned by `--caps`.

How a tool works, at length, goes in `docs/tools/<tool>.md`; this file
names the tool and points there.

Keep it to what's true on every machine that runs lanes, and update it
when a tool is added or removed.

## Images

- **To look at an image:** `just view-image <path> [--max 1568]`, then
  Read the copy it prints. Never Read a big image (a screenshot, a crop
  sheet) as it is: it goes into context at full size.
- Installed: <fill: e.g. ImageMagick (`magick`), or "nothing: view-image
  says so">
- Cropping, contact sheets, comparisons: <fill: the recipe or script that
  does it, e.g. `just crop`, or "none yet">

## Video

- Installed: <fill: e.g. ffmpeg, or "nothing">
- Frames from a clip, a clip from frames: <fill: the recipe, or "none
  yet">

## Audio

- Installed: <fill: e.g. ffmpeg, sox, or "nothing">
- Converting, trimming, measuring loudness: <fill: the recipe, or "none
  yet">

## Python

- The environment: <fill: e.g. `uv run` with the project's lock, or
  "none">. What's in it is what `pyproject.toml` (or its equivalent)
  lists; anything else isn't there.
