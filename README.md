To rebuild the app upon version update:

```bash
panel convert app.py --to pyodide-worker --out pyodide --requirements panel holoviews owslib pandas
mv pyodide/app.html pyodide/index.html
rm -rf docs
mv pyodide docs
```
