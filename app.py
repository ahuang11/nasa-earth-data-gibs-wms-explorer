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