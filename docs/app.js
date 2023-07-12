importScripts("https://cdn.jsdelivr.net/pyodide/v0.23.0/full/pyodide.js");

function sendPatch(patch, buffers, msg_id) {
  self.postMessage({
    type: 'patch',
    patch: patch,
    buffers: buffers
  })
}

async function startApplication() {
  console.log("Loading pyodide!");
  self.postMessage({type: 'status', msg: 'Loading pyodide'})
  self.pyodide = await loadPyodide();
  self.pyodide.globals.set("sendPatch", sendPatch);
  console.log("Loaded!");
  await self.pyodide.loadPackage("micropip");
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.0/dist/wheels/bokeh-3.1.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.0/dist/wheels/panel-1.2.0-py3-none-any.whl', 'pyodide-http==0.2.1', 'holoviews', 'owslib', 'pandas']
  for (const pkg of env_spec) {
    let pkg_name;
    if (pkg.endsWith('.whl')) {
      pkg_name = pkg.split('/').slice(-1)[0].split('-')[0]
    } else {
      pkg_name = pkg
    }
    self.postMessage({type: 'status', msg: `Installing ${pkg_name}`})
    try {
      await self.pyodide.runPythonAsync(`
        import micropip
        await micropip.install('${pkg}');
      `);
    } catch(e) {
      console.log(e)
      self.postMessage({
	type: 'status',
	msg: `Error while installing ${pkg_name}`
      });
    }
  }
  console.log("Packages loaded!");
  self.postMessage({type: 'status', msg: 'Executing code'})
  const code = `
  
import asyncio

from panel.io.pyodide import init_doc, write_doc

init_doc()

import panel as pn
import pandas as pd
import holoviews as hv
from owslib.wms import WebMapService

hv.extension("bokeh")
pn.extension(sizing_mode="stretch_width")

BASE_URL = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS"
XMIN = -20037507.539400
YMIN = 1638517.444800
XMAX = 20037260.918700
YMAX = 7714669.39460


class NasaEarthDataGibsWmsExplorer:
    def __init__(self):
        self.wms = WebMapService(BASE_URL)
        layers = sorted(self.wms.contents)
        self.products_layers = {"Miscellaneous": []}
        for layer in layers:
            if "_" in layer:
                product, product_layer = layer.split("_", 1)
                if product not in self.products_layers:
                    self.products_layers[product] = []
                self.products_layers[product].append(product_layer)
            else:
                self.products_layers["Miscellaneous"].append(layer)

        # create widgets
        self.product_select = pn.widgets.Select(
            name="Product",
            options=sorted(self.products_layers),
        )
        self.layer_select = pn.widgets.Select(
            name="Layer",
            options=sorted(self.products_layers[self.product_select.value]),
        )
        self.time_slider = pn.widgets.DiscreteSlider(name="Time", margin=(5, 16))
        self.refresh_button = pn.widgets.Button(name="Refresh", button_type="light")
        self.image_pane = pn.pane.Image()  # for colorbar / legend
        self.holoviews_pane = pn.pane.HoloViews(min_height=500, sizing_mode="stretch_both")
        pn.state.onload(self._onload)
    
    def _onload(self):
        # add interactivity
        self.product_select.param.watch(self.update_layers, "value")
        self.layer_select.param.watch(self.update_time, "value")
        self.refresh_button.on_click(self.update_web_map)

        # create imagery
        base_map = hv.element.tiles.EsriImagery().opts(
            xlim=(XMIN, XMAX), ylim=(YMIN, YMAX), responsive=True
        )
        self.dynamic_map = hv.DynamicMap(
            self.update_web_map, streams=[self.time_slider.param.value_throttled]
        )
        self.holoviews_pane.object = base_map * self.dynamic_map

    def get_layer(self, product=None, product_layer=None):
        product = product or self.product_select.value
        if product == "Miscellaneous":
            layer = product_layer or self.layer_select.value
        else:
            layer = f"{product}_{product_layer or self.layer_select.value}"
        return layer

    def update_layers(self, event):
        product = event.new
        product_layers = self.products_layers[product]
        self.layer_select.options = sorted(product_layers)

    def update_time(self, event):
        layer = self.get_layer()
        time_positions = self.wms.contents[layer].timepositions
        if time_positions:
            ini, end, step = time_positions[0].split("/")
            try:
                freq = pd.Timedelta(step)
            except ValueError:
                freq = step.lstrip("P")
            options = (
                pd.date_range(ini, end, freq=freq)
                .strftime("%Y-%m-%dT%H:%M:%SZ")
                .tolist()
            )
            if options:
                value = options[0]
                self.time_slider.param.set_param(options=options, value=value)
                return
        # use N/A instead of None to circumvent Panel from crashing
        # when going from time-dependent layer to time-independent layer
        options = ["N/A"]
        self.time_slider.options = options
        self.time_slider.param.trigger("value_throttled")

    def get_url_template(self, layer, time=None):
        get_map_kwargs = dict(
            layers=[layer],
            srs="EPSG:3857",
            bbox=(XMIN, YMIN, XMAX, YMAX),
            size=(256, 256),
            format="image/png",
            transparent=True,
            time=time
        )
        try:
            url = self.wms.getmap(**get_map_kwargs).geturl()
        except Exception:
            get_map_kwargs.pop("time")
            url = self.wms.getmap(**get_map_kwargs).geturl()
        url_template = (
            url.replace(str(XMIN), "{XMIN}")
            .replace(str(YMIN), "{YMIN}")
            .replace(str(XMAX), "{XMAX}")
            .replace(str(YMAX), "{YMAX}")
        )
        return url_template

    def update_web_map(self, value_throttled=None):
        try:
            self.holoviews_pane.loading = True
            layer = self.get_layer()
            time = self.time_slider.value
            if time == "N/A":
                time = None
            url_template = self.get_url_template(layer, time)
            layer_meta = self.wms[layer]
            self.image_pane.object = layer_meta.styles.get("default", {}).get("legend")
            layer_imagery = hv.Tiles(url_template).opts(title=layer_meta.title)
        finally:
            self.holoviews_pane.loading = False
        return layer_imagery

    def view(self):
        widget_box = pn.WidgetBox(
            self.product_select,
            self.layer_select,
            self.time_slider,
            self.image_pane,
            self.refresh_button,
            pn.Spacer(sizing_mode="stretch_height"),
            sizing_mode="stretch_both",
            max_width=300,
        )
        return pn.Row(
            widget_box,
            self.holoviews_pane,
        )


explorer = NasaEarthDataGibsWmsExplorer()
explorer.view().servable()

await write_doc()
  `

  try {
    const [docs_json, render_items, root_ids] = await self.pyodide.runPythonAsync(code)
    self.postMessage({
      type: 'render',
      docs_json: docs_json,
      render_items: render_items,
      root_ids: root_ids
    })
  } catch(e) {
    const traceback = `${e}`
    const tblines = traceback.split('\n')
    self.postMessage({
      type: 'status',
      msg: tblines[tblines.length-2]
    });
    throw e
  }
}

self.onmessage = async (event) => {
  const msg = event.data
  if (msg.type === 'rendered') {
    self.pyodide.runPythonAsync(`
    from panel.io.state import state
    from panel.io.pyodide import _link_docs_worker

    _link_docs_worker(state.curdoc, sendPatch, setter='js')
    `)
  } else if (msg.type === 'patch') {
    self.pyodide.globals.set('patch', msg.patch)
    self.pyodide.runPythonAsync(`
    state.curdoc.apply_json_patch(patch.to_py(), setter='js')
    `)
    self.postMessage({type: 'idle'})
  } else if (msg.type === 'location') {
    self.pyodide.globals.set('location', msg.location)
    self.pyodide.runPythonAsync(`
    import json
    from panel.io.state import state
    from panel.util import edit_readonly
    if state.location:
        loc_data = json.loads(location)
        with edit_readonly(state.location):
            state.location.param.update({
                k: v for k, v in loc_data.items() if k in state.location.param
            })
    `)
  }
}

startApplication()