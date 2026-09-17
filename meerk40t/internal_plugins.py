"""
Plugins bundled with this headless, Ruida-only build of the MeerK40t kernel:
the device manager, the Ruida driver, the core (elements, planner, cut code),
image tools for raster operations and the file loaders the service accepts
(DXF, LightBurn, xTool; SVG and images come with the core).
"""


def plugin(kernel, lifecycle):
    if lifecycle == "plugins":
        from .core import core
        from .device import basedevice
        from .dxf.plugin import plugin as dxf_plugin
        from .extra import lbrn, xcs_reader
        from .extra.coolant import plugin as coolant_plugin
        from .fill import fills, patterns
        from .image import imagetools
        from .ruida import plugin as ruida_plugin

        return [
            basedevice.plugin,
            coolant_plugin,
            ruida_plugin.plugin,
            core.plugin,
            imagetools.plugin,
            fills.plugin,
            patterns.plugin,
            dxf_plugin,
            lbrn.plugin,
            xcs_reader.plugin,
        ]
    if lifecycle == "invalidate":
        return True
