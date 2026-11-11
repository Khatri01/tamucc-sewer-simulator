# Licences: restricted edition

This site combines work under several licences.

## Code: MIT License

Applies to the agent-based model code (`model.js`, compiled from the project's NetLogo model), the coupling and
checking code (the Python modules in `py/engine.bin`) and the web app (`index.html`,
`about.html`, `app.js`, `worker.js`, `web.css`, `dash/`).

```
MIT License

Copyright (c) 2026 Bishal Khatri and Hua Zhang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Campus data: not released for reuse

The campus data built into this edition (the sewer network in `py/engine.bin` and `network.json`, which here carry pipe lengths and diameters and manhole depths but no elevations; the building and schedule data inside `model.js` and `params.json`) are © 2026 Bishal Khatri and Hua Zhang, Texas A&M University–Corpus Christi. They are included only so that the simulator can run, and are not released for reuse, copying or redistribution.

## Not covered by the licences above

- `basemap.png`, the background image of the People & buildings tab with the street map switched off. Its source imagery keeps its own terms.
- `campus_photo.jpg`, the faded aerial photo behind the page: photo by Jessica Mader, © Texas A&M University–Corpus Christi. All rights reserved by the university.
- `vendor/tortoise-compiler.js`, `vendor/tortoise-engine.min.js`: NetLogo Web (Tortoise), Center for Connected
  Learning and Computer-Based Modeling, Northwestern University; GNU General Public License version 2 or any later
  version (`licenses/GPL-2.0.txt`); source: https://github.com/NetLogo/Tortoise
- `vendor/swmm5.js`, `vendor/swmm5.wasm`: EPA SWMM 5.2.4 compiled to WebAssembly; public domain;
  source: https://github.com/USEPA/Stormwater-Management-Model
- The street map on the Sewer network and People & buildings tabs is loaded from tile.openstreetmap.org and not distributed here:
  © OpenStreetMap contributors, Open Database License (https://www.openstreetmap.org/copyright).
- Pyodide, NumPy and pandas are loaded from cdn.jsdelivr.net and not distributed here (Mozilla Public License 2.0;
  BSD licences).
