(function () {
  const bundle = window.BUNDLE;
  const bundleName = window.BUNDLE_NAME;

  document.title = `${bundleName} | OKF browser`;
  document.getElementById("bundle-name").textContent = bundleName;

  const typeSelect = document.getElementById("filter-type");
  for (const type of bundle.types) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    typeSelect.appendChild(option);
  }

  const backlinks = {};
  for (const edge of bundle.edges) {
    const { source, target } = edge.data;
    (backlinks[target] ||= []).push(source);
  }

  const nodeIndex = {};
  for (const node of bundle.nodes) {
    nodeIndex[node.data.id] = node.data;
  }

  const cy = cytoscape({
    container: document.getElementById("graph"),
    elements: [...bundle.nodes, ...bundle.edges],
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          label: "data(label)",
          color: "#13211d",
          "font-size": 12,
          "text-valign": "bottom",
          "text-margin-y": 6,
          "text-wrap": "wrap",
          "text-max-width": 140,
          width: "data(size)",
          height: "data(size)",
          "border-width": 1.5,
          "border-color": "#13211d"
        }
      },
      {
        selector: "node:selected",
        style: {
          "border-width": 4,
          "border-color": "#f59e0b"
        }
      },
      {
        selector: "edge",
        style: {
          width: 1.7,
          "line-color": "#c7cfd7",
          "target-arrow-color": "#c7cfd7",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.95
        }
      },
      {
        selector: "edge:selected",
        style: {
          "line-color": "#f59e0b",
          "target-arrow-color": "#f59e0b",
          width: 2.5
        }
      },
      {
        selector: ".dim",
        style: { opacity: 0.15 }
      }
    ],
    layout: { name: "cose", animate: false, padding: 36 },
    wheelSensitivity: 0.18
  });

  cy.on("tap", "node", (event) => showDetail(event.target.id()));
  cy.on("tap", (event) => {
    if (event.target === cy) clearSelection();
  });

  document.getElementById("layout").addEventListener("change", (event) => {
    cy.layout({ name: event.target.value, animate: false, padding: 36 }).run();
  });

  document.getElementById("reset").addEventListener("click", () => {
    cy.fit(null, 36);
    clearSelection();
  });

  document.getElementById("search").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) {
      cy.elements().removeClass("dim");
      return;
    }
    cy.nodes().forEach((node) => {
      const data = node.data();
      const haystack = [
        data.label || "",
        data.id,
        ...(data.tags || [])
      ].join(" ").toLowerCase();
      node.toggleClass("dim", !haystack.includes(query));
    });
    syncEdgesFromNodes();
  });

  typeSelect.addEventListener("change", (event) => {
    const type = event.target.value;
    if (!type) {
      cy.elements().removeClass("dim");
      return;
    }
    cy.nodes().forEach((node) => {
      node.toggleClass("dim", node.data("type") !== type);
    });
    syncEdgesFromNodes();
  });

  function syncEdgesFromNodes() {
    cy.edges().forEach((edge) => {
      edge.toggleClass("dim", edge.source().hasClass("dim") || edge.target().hasClass("dim"));
    });
  }

  function clearSelection() {
    cy.elements().unselect();
    document.getElementById("detail-empty").hidden = false;
    document.getElementById("detail-content").hidden = true;
  }

  function showDetail(conceptId) {
    const data = nodeIndex[conceptId];
    if (!data) return;

    cy.elements().unselect();
    const node = cy.getElementById(conceptId);
    node.select();

    document.getElementById("detail-empty").hidden = true;
    document.getElementById("detail-content").hidden = false;

    const typeChip = document.getElementById("detail-type");
    typeChip.textContent = data.type;
    typeChip.style.background = data.color;

    document.getElementById("detail-title").textContent = data.label;
    document.getElementById("detail-id").textContent = conceptId;
    document.getElementById("detail-description").textContent = data.description || "—";

    const resourceEl = document.getElementById("detail-resource");
    resourceEl.innerHTML = "";
    if (data.resource) {
      const link = document.createElement("a");
      link.href = data.resource;
      link.textContent = data.resource;
      resourceEl.appendChild(link);
    } else {
      resourceEl.textContent = "—";
    }

    const tagsEl = document.getElementById("detail-tags");
    tagsEl.innerHTML = "";
    if (data.tags?.length) {
      for (const tag of data.tags) {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = tag;
        tagsEl.appendChild(span);
      }
    } else {
      tagsEl.textContent = "—";
    }

    const body = bundle.bodies[conceptId] || "";
    const bodyEl = document.getElementById("detail-body");
    bodyEl.innerHTML = marked.parse(body, { breaks: false, gfm: true });
    rewriteInternalLinks(bodyEl);

    const refs = backlinks[conceptId] || [];
    const backlinkSection = document.getElementById("detail-backlinks");
    const backlinkList = document.getElementById("backlinks-list");
    backlinkList.innerHTML = "";

    if (refs.length) {
      backlinkSection.hidden = false;
      for (const ref of refs) {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.textContent = nodeIndex[ref]?.label || ref;
        link.addEventListener("click", () => showDetail(ref));
        li.appendChild(link);
        backlinkList.appendChild(li);
      }
    } else {
      backlinkSection.hidden = true;
    }

    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1) }, { duration: 180 });
  }

  function rewriteInternalLinks(root) {
    root.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href");
      if (!href) return;
      if (href.startsWith("/") && href.endsWith(".md")) {
        const target = href.slice(1, -3);
        if (nodeIndex[target]) {
          link.className = "internal";
          link.setAttribute("href", "javascript:void(0)");
          link.addEventListener("click", (event) => {
            event.preventDefault();
            showDetail(target);
          });
          return;
        }
      }
      link.target = "_blank";
      link.rel = "noopener";
    });
  }

  const initial = bundle.nodes.find((node) => node.data.type === "system") || bundle.nodes[0];
  if (initial) showDetail(initial.data.id);
})();
