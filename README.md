# Fully-hacks-2026
A repository for our FullyHacks hackathon projec: a real-time ocean events heatmap.

## Behind "Barreleye Watch"

The barreleye fish is a deep-sea fish that is known for its transparent head and tubular eyes.
These features allow it to observe and filter insights that other creatures can not.

Barreleye Watch monitors the most important ocean features real-time. It breaks down complex environmental data into insights that people can actually use. This lets communities make their own informed decisions and advocate against pollution and unsafe water conditions.

## Features
- Real-time ocean condition monitoring
- Interactive California coastal map
- Data filtering that hilights impacted areas
- Visualizations designed to be understood by everyone

## How It Works
Barreleye Watch displays environmental data pulled from authoratative datasets and displays it through an inteactive map using tools from ArcGIS. This data is put through a lens that make understanding it crystal clear.

## Run Locally (localhost)
This repo currently has a small Node server that serves the static site in `mapFrontEnd/public`.

1) Start the server
```bash
cd mapFrontEnd
npm start
# or: node server.js
```

2) Open the app
- `http://localhost:3000`
- API check: `http://localhost:3000/api`

Notes:
- Change the port with `PORT=8080 npm start`
- The map embeds external ArcGIS/Leaflet resources, so you may need an internet connection for everything to render.
- If ArcGIS layers require auth, set `ARCGIS_API_KEY` (copy `.env.example` to `.env` and put it there).
