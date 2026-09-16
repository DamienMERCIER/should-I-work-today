# Pourquoi ta note s'écarte de surf-forecast, et comment mettre les étoiles en place

Investigation du 16 septembre 2026 sur le repo `should-I-work-today` (commit `31a8abc`), avec 78 créneaux relevés sur surf-forecast.com le même jour : Muizenberg et Long Beach en 3 h par 3 h, le wavefinder Cape Town sur 7 jours, et deux spots à grosses notes pour le haut de l'échelle (Papatowai NZ, Cathedral Rock AU). Les lignes sont dans `data/sf-rows-2026-09-16.csv` et servent de tests dorés dans `test/engine/rating.test.ts`.

## 1. Les trois raisons de l'écart

### 1.1 Tu ne notes pas la même chose

Ton `score` est une note personnelle : produit de six facteurs dont `size` (fourchette de taille par niveau et planche), `tide`, `day` (lumière) et `weather`. La note surf-forecast est une note de qualité brute, pour un surfeur générique : houle dirigée vers le spot × vent, rien d'autre. Ni marée, ni niveau, ni heure.

Conséquence mécanique : un jour à 8 étoiles à Outer Kom vaut 0 chez toi pour un `intermediate`, parce que la face sort de sa fourchette. Un créneau de 5 h vaut 0 chez toi (nuit) et 4 chez eux. Comparer les deux nombres bruts n'a pas de sens tant que la note « qualité » n'est pas séparée de la note « pour toi ».

### 1.2 Tu ne lis pas la même houle

Le moteur prend la houle à un seul point au large par région (`swellRef` de `cape-peninsula` : 34,5 S, 18,2 E) et la ramène au spot par `exposure` (0,35 à Muizenberg, 1,1 à Outer Kom), converti en pieds de face. Surf-forecast lit son modèle de vagues sur un point côtier propre à chaque break et affiche la hauteur « swell directed towards the surf break » en eau libre près du bord, en prévenant que les vagues qui déferlent sont souvent plus petites.

Sur le 16/09 ça donne : Muizenberg 2,1 m SW 14 s (« 7 ft », 1812 kJ) chez eux, alors que ton moteur sort une face d'environ 3 ft (2,1 × 3,28 × 0,35 × 1,3). Les deux ont raison dans leur système : leur 2,1 m n'est pas une hauteur de face, c'est un Hs côtier. Leur note d'étoiles est calculée sur ce Hs côtier, donc tant que tu n'as pas une hauteur du même type, tu ne peux pas retomber sur leurs étoiles. Bonne nouvelle : l'API marine d'Open-Meteo accepte plusieurs points par appel, exactement comme ton appel `forecast` pour le vent. Demander la houle à la cellule de chaque spot en plus du point régional ne coûte aucune sous-requête supplémentaire. C'est ce que fait le script de comparaison, pour mesurer avant de brancher.

### 1.3 Le vent : six états chez eux, trois chez toi, et des courbes qui ne se ressemblent pas

Surf-forecast classe le vent en six états par secteurs de 45° autour de la direction offshore : glassy (moins de 5 km/h), off, cross-off, cross, cross-on, on. Ton `windRelation` en a trois : offshore jusqu'à 45°, cross jusqu'à 100°, onshore au-delà. Ton « cross » recouvre leur cross-off et leur cross, qui n'ont rien à voir en pénalité.

Ce que disent les 78 lignes, en km/h (la table du site), avec ton équivalent en km/h pour comparer :

| état vent | surf-forecast : facteur observé | ton `SCORING.wind` (converti) |
|---|---|---|
| off | ×1 jusqu'à 30 km/h, ×0,75 à 35, ×0,4 à 45, 0 vers 55 | ×1 jusqu'à 18,5, ×0,75 à 28, ×0,45 à 37, 0 à 55 |
| cross-off | ×1 jusqu'à 15, ×0,9 à 25, ×0,4 à 35, ×0,2 à 40, ×0,07 à 45, 0 à 50 | pas d'état séparé (offshore ou cross selon l'angle) |
| cross | ×0,83 à 10, ×0,65 à 15, ×0,4 à 20, 0 vers 30 | ×1 jusqu'à 15, ×0,5 à 28, 0 à 46 |
| cross-on | ×0,75 à 5, ×0,6 à 10, ×0,3 à 15, 0 à 20 | (onshore) ×1 jusqu'à 9, ×0,5 à 18,5, 0 à 33 |
| on | ×0,7 à 5, ×0,45 à 10, ×0,1 à 15, 0 à 18 | ×1 jusqu'à 9, ×0,5 à 18,5, 0 à 33 |

Deux lectures :

- Leur onshore est environ deux fois plus sévère que le tien : 0 dès 20 km/h (11 kt), même sur 4,5 m 18 s à Cathedral Rock. Chez toi, 11 kt onshore laisse encore ×0,44.
- Leur offshore est plus tolérant que le tien : rien ne bouge avant 30 km/h (16 kt), quand ta courbe commence à mordre à 10 kt et vaut ×0,45 à 20 kt.

Sur l'épisode Kommetjie de ton commentaire dans `config.ts` (SE 16 kt, 2,2 m 12 s, 9,8/10 chez toi contre 0/10 chez eux), le 0 du site ne vient pas d'une pénalité offshore : le site fait face au nord pour Long Beach (guide : « offshore winds are from the south »), donc son SE est un cross-off, et il voyait 45 km/h là où Open-Meteo te donnait 30. Deux écarts de données (orientation et vitesse), pas une différence de philosophie sur l'offshore. Durcir la courbe offshore comme tu l'as fait corrige ce cas mais pénalise tous les vrais offshore modérés ailleurs (Muizenberg par NW 30 km/h : pleine note chez eux, ×0,7 chez toi).

Le site n'utilise pas la rafale. Ton `gustFactor` est une bonne idée en soi, mais c'est une source d'écart de plus à garder en tête quand tu compares.

## 2. La note surf-forecast, reconstruite

Sur les 44 lignes à vent propre (glassy, off, cross-off léger), la note de base ne dépend presque que de la hauteur :

    base = 1,81 + 0,37·H + 0,23·H²   (H en m, houle dirigée vers le spot, bornée à 10)

soit à peu près « une demi-étoile par pied » : 0,7 m → 2, 1,5 m → 3, 2,3 m → 4, 3 m → 5, 3,5 m → 6, 4 m → 7-8, 5 m → 9. La période n'a pas de poids mesurable dans ces lignes (écart ±1 entre 10 s et 18 s), malgré la FAQ du site. À revoir quand tu auras plus de lignes.

L'énergie affichée vaut ≈ 2·H²·T² kJ (ratio 0,9 à 1,0 sur nos lignes).

La note finale = arrondi(base × facteur vent), avec les courbes du tableau ci-dessus. Le modèle tombe juste sur 71 % des 78 lignes et à ±1 étoile sur 97 %, ce qui est le mieux qu'on puisse espérer avec des hauteurs arrondies au 0,1 m et des vents aux 5 km/h. Le « ! » que le site affiche parfois à la place de la note (Papatowai 5 m et plus par 30 km/h et plus) est un drapeau danger, pas une note : le script le stocke tel quel.

Les étoiles jaunes : d'après la FAQ et les notes de version de l'app, or = vagues propres (glassy, off, cross-off), blanc = note dégradée par une composante onshore (cross-on, on). Ce n'est pas un score en plus, c'est la couleur de la même note. J'ai rangé cross pur avec les blanches (le site dit « cross winds can be good if offshore and bad if onshore », donc un cross qui coûte des étoiles n'est pas propre). Sur Telegram tu n'as pas de couleur : ★★★★ pour l'or, ☆☆☆☆ pour le blanc, un point pour 0.

Tout ça est dans `src/engine/rating.ts` (`rateLikeSurfForecast`, `windState`, `starGlyphs`), sans dépendance au scoring.

## 3. Comment le brancher

1. Mesurer avant de toucher au moteur : `npm run compare:sf` tous les jours pendant deux ou trois semaines. Le script lit la table 3 h par 3 h du site pour chaque spot curaté qui a un slug, met en face ce que ton moteur calcule aux mêmes heures (houle régionale, houle à la cellule du spot, vent, face, score, étoiles) et ajoute tout à `data/sf-compare.csv`. Il imprime par spot : moyenne site vs bot, erreur moyenne en étoiles selon la houle utilisée, écart de hauteur, écart de vent, accord sur l'état du vent. Au premier run, vérifier avec `--dump-html tmp/` que le parseur trouve bien les lignes (il est écrit d'après le rendu texte des pages, pas d'après le HTML brut).
2. Dans `collect.ts`, passer les spots à `fetchMarine` en plus de `region.swellRef` (un seul appel, N points) et garder par spot la série côtière. Donner à `evaluateSpot` la hauteur côtière effective (`effectiveSwell(spotHour, spot.swellWindow).heightM`) et ajouter `stars`, `clean` et `windState` à `SpotHour`.
3. Réorganiser le score personnel autour des étoiles : `score = stars × sizeFit × tideFit × daylight × weather`. Les étoiles deviennent la note qualité comparable au site, tes facteurs deviennent des filtres « pour toi ». Le message du soir peut alors montrer les deux : « Muizenberg ☆☆ (onshore) · pour toi 0/10 » ou « Long Beach ★★★★ · pour toi 8/10 ».
4. Recaler avec le CSV : `exposure` par spot (rapport entre ta hauteur côtière et la leur), puis les courbes de vent, puis la base. Spot par spot, pas seulement Muizenberg : les écarts d'orientation (Long Beach, Outer Kom) et de vitesse de vent (Kommetjie sous le Cape Doctor) ne se voient qu'en comparant plusieurs spots le même jour.

Point d'attention : les orientations du site sont approximatives (Long Beach face au nord, Outer Kom face au SW chez eux). Reproduire leurs étoiles à l'identique voudrait dire reproduire ces erreurs. L'objectif raisonnable est une note dans la même échelle, avec les mêmes règles de vent, sur tes orientations à toi. Le script mesure justement l'écart d'état du vent pour repérer les spots où ça diverge.

## 4. Ce que contient le patch

- `src/engine/rating.ts` : le module, avec les constantes commentées et les sources.
- `test/engine/rating.test.ts` : les 78 lignes en tests dorés (±1 étoile sur 95 % minimum, exact sur 65 % minimum), plus les secteurs de vent et les glyphes.
- `scripts/compare-surf-forecast.ts` et `npm run compare:sf` : la calibration, avec `--spots`, `--out`, `--dump-html`, `--from-html`.
- `test/scripts/compareSurfForecast.test.ts` : le parseur sur une fixture synthétique (colspan, AM/PM, changement de mois, « ! »).
- `data/sf-rows-2026-09-16.csv` : les relevés bruts.

Suite complète : 494 tests verts sur 495. Le seul rouge vu ici est `world.test.ts`, qui mesure un temps CPU sous 5 ms et a fait 5,16 ms dans mon environnement, sans rapport avec ces fichiers.
