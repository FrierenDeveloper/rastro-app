#!/usr/bin/env python3
"""Genera los iconos de la app Android a partir de los de la PWA.

Replica el comportamiento de Bubblewrap: reescala cada icono a las densidades
de Android y, cuando hay fondo, sustituye el RGB de los píxeles transparentes
por el color de fondo para evitar halos al reescalar.

Uso (desde android/):  python3 tools/generar_iconos.py
"""
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
ICONOS = RAIZ.parent / "frontend" / "icons"
RES = RAIZ / "app" / "src" / "main" / "res"

FONDO = (245, 242, 235)  # #F5F2EB, igual que el manifest

LAUNCHER = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
MASKABLE = {"mdpi": 82, "hdpi": 123, "xhdpi": 164, "xxhdpi": 246, "xxxhdpi": 328}
NOTIFICACION = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}
SPLASH = {"mdpi": 300, "hdpi": 450, "xhdpi": 600, "xxhdpi": 900, "xxxhdpi": 1200}


def con_fondo(imagen):
    """Pinta el RGB de los píxeles totalmente transparentes con el color de fondo."""
    imagen = imagen.convert("RGBA")
    pixeles = imagen.load()
    for y in range(imagen.height):
        for x in range(imagen.width):
            r, g, b, a = pixeles[x, y]
            if a == 0:
                pixeles[x, y] = (FONDO[0], FONDO[1], FONDO[2], 0)
    return imagen


def guardar(imagen, carpeta, nombre, tamanos):
    # Android espera el calificador en el nombre de la carpeta (`mipmap-mdpi`),
    # no una subcarpeta (`mipmap/mdpi`): si no, AAPT no encuentra el recurso.
    for densidad, tamano in tamanos.items():
        ruta = RES / f"{carpeta}-{densidad}" / f"{nombre}.png"
        ruta.parent.mkdir(parents=True, exist_ok=True)
        imagen.resize((tamano, tamano), Image.LANCZOS).save(ruta, "PNG")


def silueta_blanca(imagen):
    """Deja la forma del icono en blanco puro conservando el alfa."""
    imagen = imagen.convert("RGBA")
    pixeles = imagen.load()
    for y in range(imagen.height):
        for x in range(imagen.width):
            _, _, _, a = pixeles[x, y]
            pixeles[x, y] = (255, 255, 255, a)
    return imagen


def main():
    normal = Image.open(ICONOS / "icon-512.png")
    maskable = Image.open(ICONOS / "icon-maskable-512.png")
    notificacion = Image.open(ICONOS / "icon-maskable-512.png")

    guardar(con_fondo(normal), "mipmap", "ic_launcher", LAUNCHER)
    guardar(con_fondo(maskable), "mipmap", "ic_maskable", MASKABLE)
    guardar(con_fondo(normal), "mipmap", "ic_launcher_round", LAUNCHER)
    guardar(silueta_blanca(notificacion), "drawable", "ic_notification_icon", NOTIFICACION)
    guardar(con_fondo(normal), "drawable", "splash", SPLASH)
    guardar(con_fondo(normal), "drawable", "shortcut_icon", LAUNCHER)
    print("Iconos generados en", RES)


if __name__ == "__main__":
    main()
