const WEBMAP_ID = "51c484672c7441bdb6175f41e1127b72";
const PORTAL_URL = "https://pomona.maps.arcgis.com";

const drawer = document.getElementById("infoDrawer");
const drawerHandle = document.getElementById("drawerHandle");
const drawerChevron = document.getElementById("drawerChevron");
const mapNotice = document.getElementById("mapNotice");
const selectedLayerLabel = document.getElementById("selectedLayerLabel");
const visibleLayerList = document.getElementById("visibleLayerList");
const showAllButton = document.getElementById("show-all");
const hideAllButton = document.getElementById("hide-all");
const layerButtons = Array.from(document.querySelectorAll(".tool-btn[data-layer-title]"));
const runScrapeButton = document.getElementById("run-scrape");
const scrapeStatus = document.getElementById("scrapeStatus");
const scrapeSummary = document.getElementById("scrapeSummary");
const scrapeResults = document.getElementById("scrapeResults");

const layerRegistry = new Map();
let trackedLayers = [];

const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");
const shortLabel = (button) =>
  button.dataset.shortLabel || button.textContent.replace(/^Toggle\s+/i, "").trim();

function toggleDrawer() {
  drawer.classList.toggle("open");
  drawerChevron.textContent = drawer.classList.contains("open") ? "▼" : "▲";
}

function openDrawer() {
  drawer.classList.add("open");
  drawerChevron.textContent = "▼";
}

function setControlsEnabled(enabled) {
  layerButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  showAllButton.disabled = !enabled;
  hideAllButton.disabled = !enabled;
}

function setMapNotice(message, isError = false) {
  const hasMessage = Boolean(message);
  mapNotice.hidden = !hasMessage;
  mapNotice.classList.toggle("error", hasMessage && isError);
  mapNotice.textContent = hasMessage ? message : "";
}

function setStatus(lastAction, visibleLabels) {
  selectedLayerLabel.textContent = lastAction;
  visibleLayerList.textContent = visibleLabels.length ? visibleLabels.join(", ") : "None";
}

function registerLayer(layer, ancestors = []) {
  const title = layer.title || layer.id;
  layerRegistry.set(normalize(title), { layer, ancestors, title });

  if (layer.layers && typeof layer.layers.forEach === "function") {
    layer.layers.forEach((childLayer) => {
      registerLayer(childLayer, [...ancestors, layer]);
    });
  }
}

function getLayerEntry(layerTitle) {
  return layerRegistry.get(normalize(layerTitle));
}

function isEffectivelyVisible(entry) {
  return entry.layer.visible && entry.ancestors.every((ancestor) => ancestor.visible);
}

function setLayerVisibility(entry, visible) {
  if (!entry) {
    return;
  }

  if (visible) {
    entry.ancestors.forEach((ancestor) => {
      ancestor.visible = true;
    });
  }

  entry.layer.visible = visible;
}

function syncButtons(lastAction) {
  const visibleLabels = [];

  trackedLayers.forEach(({ button, entry }) => {
    if (!entry) {
      button.disabled = true;
      button.classList.remove("active");
      button.classList.add("unavailable");
      button.setAttribute("aria-pressed", "false");
      return;
    }

    const visible = isEffectivelyVisible(entry);
    button.classList.toggle("active", visible);
    button.classList.remove("unavailable");
    button.setAttribute("aria-pressed", String(visible));

    if (visible) {
      visibleLabels.push(shortLabel(button));
    }
  });

  setStatus(lastAction, visibleLabels);
}

function setAllLayersVisibility(visible) {
  trackedLayers.forEach(({ entry }) => {
    setLayerVisibility(entry, visible);
  });

  syncButtons(visible ? "All tracked layers visible" : "All tracked layers hidden");
}

function setScrapeStatus(message, isError = false) {
  scrapeStatus.textContent = message;
  scrapeStatus.classList.toggle("error", isError);
}

function truncateText(text, maxLength = 320) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function getResultTitle(result) {
  const metadata = result && result.metadata && typeof result.metadata === "object" ? result.metadata : {};
  if (metadata.title) {
    return String(metadata.title);
  }

  const firstLine = String(result.text || "").split("\n").find((line) => line.trim());
  return firstLine ? firstLine.trim() : "Untitled result";
}

function getResultMeta(result) {
  const metadata = result && result.metadata && typeof result.metadata === "object" ? result.metadata : {};
  const platform = metadata.platform ? String(metadata.platform) : "unknown";
  const createdAt = metadata.created_iso || metadata.created_at || metadata.seendate || "";
  return createdAt ? `${platform} • ${createdAt}` : platform;
}

function renderResultList(results) {
  scrapeResults.replaceChildren();

  if (!Array.isArray(results) || !results.length) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = "The scraper ran, but it did not return any matching results.";
    scrapeResults.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  results.forEach((result) => {
    const card = document.createElement("article");
    card.className = "result-card";

    const title = document.createElement("h3");
    title.textContent = getResultTitle(result);

    const meta = document.createElement("p");
    meta.className = "result-meta";
    meta.textContent = getResultMeta(result);

    const excerpt = document.createElement("p");
    excerpt.className = "result-excerpt";
    excerpt.textContent = truncateText(result.text || "", 340);

    const link = document.createElement("a");
    link.className = "result-link";
    link.href = String(result.source || "#");
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "Open source";

    card.append(title, meta, excerpt, link);
    fragment.append(card);
  });

  scrapeResults.append(fragment);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    throw new Error("Expected a JSON response from the server.");
  }

  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The server returned invalid JSON.");
    }
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}.`);
  }

  return data;
}

async function loadStoredEventSummary() {
  try {
    const payload = await fetchJson("/api/events");
    setScrapeStatus(`Stored events: ${payload.result_count || 0}`);
  } catch (error) {
    setScrapeStatus(error.message || "Could not load stored event count.", true);
  }
}

async function runScrape() {
  runScrapeButton.disabled = true;
  setScrapeStatus("Running websEvent.py…");
  scrapeSummary.textContent = "The scraper is running. This can take a little while if the public APIs respond slowly.";

  try {
    const payload = await fetchJson("/api/events/scrape", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({}),
    });

    setScrapeStatus(`Stored events: ${payload.stored_result_count || 0}`);
    scrapeSummary.textContent =
      `${payload.scraped_result_count || 0} results returned, ` +
      `${payload.new_results_added || 0} new results merged into jason.json, ` +
      `${payload.duplicate_results_skipped || 0} duplicates skipped.`;
    renderResultList(payload.results || []);
    openDrawer();
  } catch (error) {
    setScrapeStatus(error.message || "The scraper request failed.", true);
    scrapeSummary.textContent =
      error.message || "The scraper request failed before any results could be displayed.";
    renderResultList([]);
    openDrawer();
  } finally {
    runScrapeButton.disabled = false;
  }
}

function initMap() {
  drawerHandle.addEventListener("click", toggleDrawer);
  runScrapeButton.addEventListener("click", runScrape);
  setControlsEnabled(false);
  loadStoredEventSummary();

  if (typeof require !== "function") {
    setMapNotice("ArcGIS failed to load.", true);
    setStatus("ArcGIS loader unavailable", []);
    return;
  }

  require(
    [
      "esri/config",
      "esri/WebMap",
      "esri/views/MapView",
      "esri/widgets/Legend",
      "esri/widgets/Expand",
    ],
    (esriConfig, WebMap, MapView, Legend, Expand) => {
      esriConfig.portalUrl = PORTAL_URL;

      if (window.__ARCGIS_API_KEY) {
        esriConfig.apiKey = window.__ARCGIS_API_KEY;
      }

      const webmap = new WebMap({
        portalItem: {
          id: WEBMAP_ID,
        },
      });

      const view = new MapView({
        container: "california-map",
        map: webmap,
        popup: {
          dockEnabled: true,
          dockOptions: {
            breakpoint: false,
            buttonEnabled: false,
            position: "bottom-right",
          },
        },
      });

      const legend = new Legend({ view });
      const legendExpand = new Expand({
        view,
        content: legend,
        expanded: true,
      });

      view.ui.add(legendExpand, "bottom-right");

      Promise.all([webmap.loadAll(), view.when()])
        .then(() => {
          layerRegistry.clear();
          webmap.layers.forEach((layer) => {
            registerLayer(layer);
          });

          trackedLayers = layerButtons.map((button) => ({
            button,
            entry: getLayerEntry(button.dataset.layerTitle),
          }));

          const missingButtons = trackedLayers
            .filter(({ entry }) => !entry)
            .map(({ button }) => shortLabel(button));

          setControlsEnabled(true);
          setMapNotice("");
          syncButtons("ArcGIS map ready");

          if (missingButtons.length) {
            setMapNotice(
              `Some controls could not be matched to a layer: ${missingButtons.join(", ")}`,
              true,
            );
          }

          layerButtons.forEach((button) => {
            button.addEventListener("click", () => {
              const trackedLayer = trackedLayers.find((item) => item.button === button);
              if (!trackedLayer || !trackedLayer.entry) {
                return;
              }

              const nextVisible = !isEffectivelyVisible(trackedLayer.entry);
              setLayerVisibility(trackedLayer.entry, nextVisible);
              syncButtons(`${shortLabel(button)} ${nextVisible ? "shown" : "hidden"}`);
            });
          });

          showAllButton.addEventListener("click", () => {
            setAllLayersVisibility(true);
          });

          hideAllButton.addEventListener("click", () => {
            setAllLayersVisibility(false);
          });
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.error(error);
          setControlsEnabled(false);
          setMapNotice(
            "ArcGIS map could not be loaded. Check the portal item, network access, and API key.",
            true,
          );
          setStatus("ArcGIS load failed", []);
        });
    },
  );
}

initMap();
