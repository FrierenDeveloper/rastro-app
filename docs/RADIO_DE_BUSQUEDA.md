# Radio de búsqueda: en qué se basa

Este documento explica de dónde salen los números que la app usa para sugerir
hasta dónde buscar una mascota perdida y a quién avisar por zona. Existe para
que nadie tenga que adivinar por qué el radio de un gato es tan chico, y para
que quede claro **qué parte está respaldada por estudios y qué parte es una
modelización nuestra**.

El código está en `backend/busqueda.js` (con los mismos comentarios).

---

## 1. Lo que dicen los estudios

### Gatos: se esconden muy cerca

**Huang, L.; Coradini, M.; Rand, J.; Morton, J.; Albrecht, K.; Wasson, B.;
Robertson, D. (2018).** *Search Methods Used to Locate Missing Cats and
Locations Where Missing Cats Are Found.* **Animals 8(1):5.**
Acceso abierto: https://www.mdpi.com/2076-2615/8/1/5

Estudio sobre **1.210 gatos perdidos** (encuesta a dueños). Resultados clave:

| Dato | Valor |
|---|---|
| Mediana de distancia al punto de escape | **50 m** |
| Distancia del 50% de los gatos encontrados vivos | dentro de **50 m** |
| Distancia del 75% | dentro de **500 m** |
| Distancia máxima registrada | **1,5 km** |
| Gatos "indoor" (solo interior) | se encontraron **aún más cerca** |

Conclusión práctica que el propio estudio destaca: buscar lejos es un error. Lo
que funciona es revisar a fondo la casa, los patios vecinos y los escondites
cercanos (bajo terrazas, autos, galpones).

### Perros: se recuperan sobre todo por difusión

**Lord, L.K.; Wittum, T.E.; Ferketich, A.K.; Rajala-Schultz, P.J.; Funk, J.A.
(2007).** *Search and identification methods that owners use to find a lost dog.*
**JAVMA 230(2):211-216.** https://pubmed.ncbi.nlm.nih.gov/17223753/

**Lord, L.K. et al. (2007).** *Search methods that people use to find owners of
lost pets.* **JAVMA 230(12):1835-1841.**

Estudio en Dayton (Ohio) con **187 perros y 138 gatos** perdidos:

| Dato | Perros | Gatos |
|---|---|---|
| Recuperados | **71%** | 53% |
| Volvieron solos | **8%** | 66% |
| Encontrados en un refugio | **más de un tercio (35%)** | 7% |
| Encontrados por un cartel en el barrio | **15%** | 11% |
| Llevaban chapa/microchip | 48% | 19% |

Lo importante para la app: **un perro casi nunca vuelve solo**. Aparece porque
alguien lo encuentra y lo reporta — de ahí que el cartel, los refugios y las
veterinarias rindan más que caminar kilómetros.

### Perros: la distancia concreta

**Ignatius, A. (2015).** *Distance Traveled by Lost Dogs from Lost Location to
Found Location.* Tesis de Máster, Saint Mary's University of Minnesota.
http://gis.smumn.edu/GradProjects/IgnatiusA.pdf

Este trabajo (que analiza datos de tres municipios de Minnesota) usa **~400 m
(0,25 millas)** como radio de búsqueda típico del perro, valor que toma de
Lord et al. Es la referencia que ancla el valor base del perro en la app.

---

## 2. Cómo se convierte eso en un número

Los estudios dan **distancias**, sobre todo la distancia al momento de
encontrar a la mascota. **No existe una curva publicada de "distancia según las
horas transcurridas"**: nadie ha medido "a las 6 horas el perro medio está a
X km". Así que:

* **Está respaldado por los estudios** (el valor base y el tope):
  * gato: base **50 m** (la mediana publicada), tope **1,5 km** (el máximo observado)
  * perro: base **400 m** (el radio típico citado)
* **Es modelización nuestra** (cómo crece con el tiempo):

```
radio(horas) = base + crece · sqrt(horas / 24)      (con un tope por especie)
```

La raíz del tiempo es como se dispersa un desplazamiento aleatorio (caminata
aleatoria): crece rápido al principio y luego se estanca. Es **deliberadamente
conservador**: preferimos que alguien revise bien la zona cercana a mandarlo a
recorrer 20 km.

### Valores resultantes

| Horas | Gato | Perro | Ave |
|---|---|---|---|
| 0 (ahora) | 50 m | 400 m | 300 m |
| 6 h | 180 m | 1,2 km | 1,3 km |
| 24 h | 300 m | 2,0 km | 2,3 km |
| 72 h | 480 m | 3,2 km | 3,8 km |
| 7 días | 710 m | 4,6 km | 5,6 km |
| 30 días | 1,4 km (tope) | 9,2 km | 11,3 km |

Fíjate en el gato: a las 72 horas sigue bajo los 500 m donde aparece el 75% de
los gatos del estudio. Eso es intencional — sugiere buscar cerca aunque haya
pasado tiempo.

---

## 3. Las alertas por zona usan otro mínimo

El radio de **búsqueda** de un gato son decenas de metros, pero el radio de
**aviso** no puede serlo: avisar solo a la casa de al lado desperdiciaría la
alerta. Por eso el push por zona usa `max(radio, 500 m)` — exactamente la
distancia donde el estudio ubica al 75% de los gatos encontrados.

---

## 4. Si alguien quiere cambiar los números

1. Los valores están en `PERFIL`, en `backend/busqueda.js`.
2. **La misma fórmula está duplicada** en `frontend/app.js` (`RADIO_PERFIL`)
   para poder mostrar la sugerencia al instante sin ir al servidor.
   Si cambias una, cambia la otra.
3. Hay una prueba que compara ambas implementaciones en 55 combinaciones
   (`node .audit/grafico.mjs`): si se separan, falla.
4. Si algún día aparece un **estudio de perros** con curva distancia-tiempo
   (el Missing Animal Response Network anunció que quiere hacerlo), ese es el
   dato que reemplazaría la modelización de la raíz del tiempo.
