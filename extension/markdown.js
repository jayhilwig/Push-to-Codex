(() => {
  const omitted = "button, input, select, textarea, svg, script, style, .sr-only, [hidden], " +
    "[role=button], [role=toolbar], [aria-hidden=true], [data-testid=copy-code-button], " +
    "[data-testid=webpage-citation], header:has(button[aria-label=Copy])";
  const block = "address, article, aside, blockquote, div, dl, figure, footer, h1, h2, h3, h4, h5, h6, " +
    "header, hr, main, ol, p, pre, section, table, ul";
  const children = node => Array.from(node.childNodes);
  function ticks(text, minimum) {
    let count = minimum;
    for (const match of text.matchAll(/`+/g)) count = Math.max(count, match[0].length + 1);
    return "`".repeat(count);
  }
  const escape = text => text.replace(/[\\`*_\[\]<>]/g, "\\$&");

  function list(node) {
    let number = Number(node.getAttribute("start") || 1);
    return Array.from(node.children).filter(item => item.tagName === "LI").map(item => {
      if (item.hasAttribute("value")) number = Number(item.getAttribute("value"));
      const prefix = node.tagName === "OL" ? `${number++}. ` : "- ";
      const checkbox = item.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
      const contents = (checkbox ? (checkbox.checked ? "[x] " : "[ ] ") : "") + blocks(item);
      return prefix + contents.replace(/\n(?=.)/g, "\n" + " ".repeat(prefix.length));
    }).join("\n");
  }

  function table(node) {
    const rows = Array.from(node.rows, row => Array.from(row.cells,
      cell => blocks(cell).replace(/\|/g, "\\|").replace(/\n+/g, "<br>")));
    const width = Math.max(0, ...rows.map(row => row.length));
    if (!width) return "";
    if (!node.rows[0].querySelector("th")) rows.unshift([]);
    rows.splice(1, 0, Array(width).fill("---"));
    return rows.map(row => "| " +
      Array.from({ length: width }, (_, index) => row[index] || "").join(" | ") + " |").join("\n");
  }

  function render(node) {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.data);
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(omitted)) return "";
    const body = () => children(node).map(render).join("");
    if (node.matches(".katex")) {
      const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (latex) return node.closest(".katex-display") ? `$$\n${latex}\n$$` : `$${latex}$`;
    }
    if (node.matches("h1, h2, h3, h4, h5, h6")) return "#".repeat(Number(node.tagName[1])) + " " + body().trim();
    switch (node.tagName) {
      case "BR": return "  \n";
      case "HR": return "---";
      case "PRE": {
        const code = node.querySelector("code");
        const source = code || node;
        const copy = source.cloneNode(true);
        copy.querySelectorAll(omitted).forEach(control => control.remove());
        copy.querySelectorAll("br").forEach(line => line.replaceWith("\n"));
        const text = copy.textContent;
        const language = code?.className.match(/(?:^|\s)language-([\w.+#-]+)/)?.[1]
          || node.getAttribute("data-language")?.match(/^[\w.+#-]+$/)?.[0] || "";
        const fence = ticks(text, 3);
        return fence + language + "\n" + text + (text.endsWith("\n") ? "" : "\n") + fence;
      }
      case "P": return body().trim();
      case "CODE": {
        const text = node.textContent;
        const fence = ticks(text, 1);
        const pad = /^[ `]|[ `]$/.test(text) ? " " : "";
        return fence + pad + text + pad + fence;
      }
      case "STRONG": case "B": return "**" + body() + "**";
      case "EM": case "I": return "*" + body() + "*";
      case "DEL": case "S": return "~~" + body() + "~~";
      case "UL": case "OL": return list(node);
      case "BLOCKQUOTE": return blocks(node).split("\n").map(line => "> " + line).join("\n");
      case "TABLE": return table(node);
      case "A": {
        const label = body().trim();
        const href = node.getAttribute("href");
        if (!label || !href || !/^https?:$/.test(node.protocol)) return label;
        return `[${label}](<${node.href.replace(/[<>\s]/g, encodeURIComponent)}>)`;
      }
      case "IMG": return escape(node.alt || "");
      default: return node.matches(block) ? blocks(node) : body();
    }
  }

  function blocks(node) {
    const parts = [];
    let inline = "";
    for (const child of children(node)) {
      if (child.nodeType === Node.ELEMENT_NODE && child.matches(block)) {
        if (inline.trim()) parts.push(inline.trim());
        inline = "";
        const content = render(child);
        if (content.trim()) parts.push(content);
      } else {
        inline += render(child);
      }
    }
    if (inline.trim()) parts.push(inline.trim());
    return parts.join("\n\n");
  }

  function read(root, range) {
    if (!range) return blocks(root);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return "";
    const parent = range.commonAncestorContainer;
    let fragment = range.cloneContents();
    // cloneContents drops the shared ancestors of a selection inside one paragraph or code block.
    for (let element = parent.nodeType === Node.ELEMENT_NODE ? parent : parent.parentElement;
      element && element !== root; element = element.parentElement) {
      const wrapper = element.cloneNode(false);
      wrapper.append(fragment);
      fragment = wrapper;
    }
    const container = document.createElement("div");
    container.append(fragment);
    return blocks(container);
  }

  globalThis.PushMarkdown = { read };
})();
