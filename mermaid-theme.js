// Independently authored with Mermaid's public theme API. Node shapes and
// author-supplied classDef/style declarations remain part of the original graph.
const palettes = {
  light: {
    node: '#e5f3ff', label: '#f5faff', text: '#004f99', border: '#8aa7c1',
    labelBorder: '#cedbe5', line: '#1a1c1f7e', group: '#f7f8fa',
    groupBorder: '#d9dde2', groupText: '#5c626b'
  },
  dark: {
    node: '#00284d', label: '#000e1a', text: '#99ceff', border: '#ffffff1a',
    labelBorder: '#1a3e5f', line: '#ffffff7f', group: '#1b2026',
    groupBorder: '#353c45', groupText: '#bac2cd'
  }
};

export function mermaidConfig({dark = false, fontFamily = 'sans-serif', layout = 'dagre'} = {}) {
  const p = palettes[dark ? 'dark' : 'light'];
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: dark,
    layout,
    htmlLabels: false,
    fontFamily,
    fontSize: 14,
    themeVariables: {
      darkMode: dark,
      fontFamily,
      fontSize: '14px',
      background: 'transparent',
      primaryColor: p.node,
      primaryTextColor: p.text,
      primaryBorderColor: p.border,
      secondaryColor: p.label,
      secondaryTextColor: p.text,
      secondaryBorderColor: p.labelBorder,
      tertiaryColor: p.group,
      tertiaryTextColor: p.groupText,
      tertiaryBorderColor: p.groupBorder,
      mainBkg: p.node,
      nodeBorder: p.border,
      nodeTextColor: p.text,
      textColor: p.text,
      titleColor: p.groupText,
      lineColor: p.line,
      defaultLinkColor: p.line,
      arrowheadColor: p.line,
      edgeLabelBackground: p.label,
      clusterBkg: p.group,
      clusterBorder: p.groupBorder,
      actorBkg: p.node,
      actorBorder: dark ? p.labelBorder : p.border,
      actorTextColor: p.text,
      actorLineColor: p.line,
      signalColor: p.line,
      signalTextColor: p.text,
      labelBoxBkgColor: p.label,
      labelBoxBorderColor: p.labelBorder,
      labelTextColor: p.text,
      loopTextColor: p.text,
      noteBkgColor: p.group,
      noteBorderColor: p.groupBorder,
      noteTextColor: p.groupText,
      activationBkgColor: p.label,
      activationBorderColor: p.labelBorder
    },
    // Colors come from themeVariables so Mermaid's author styles can override
    // them. Avoid !important and descendant fill rules that mask classDef text.
    themeCSS: `
      .node text, .node .label {
        font-family: ${fontFamily};
        font-size: 14px;
        font-weight: 600;
        letter-spacing: normal;
      }
      .node tspan[font-weight="normal"] { font-weight: inherit; }
      .node rect { rx: 16px; ry: 16px; }
      .node rect, .node circle, .node ellipse, .node polygon, .node path, rect.actor {
        stroke-width: ${dark ? 1 : 1.25}px;
      }
      .edgeLabel text, .edgeLabel tspan {
        font-family: ${fontFamily};
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.08px;
      }
      .edgeLabel rect {
        fill-opacity: 1;
        stroke: ${p.labelBorder};
        stroke-width: 1px;
        rx: 13px;
        ry: 13px;
      }
      .edgePaths .flowchart-link {
        stroke-width: 1px;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .cluster rect { rx: 16px; ry: 16px; }
      .cluster-label text { font-family: ${fontFamily}; font-size: 13px; font-weight: 600; }
      text.actor { font-family: ${fontFamily}; font-size: 14px; font-weight: 600; }
      rect.actor { rx: 16px; ry: 16px; }
      .messageText, .noteText, .loopText, .labelText {
        font-family: ${fontFamily};
        font-size: 14px;
      }
    `,
    flowchart: {
      useMaxWidth: false,
      htmlLabels: false,
      padding: 16,
      wrappingWidth: 280,
      nodeSpacing: 50,
      rankSpacing: 50,
      diagramPadding: 24,
      curve: 'linear'
    },
    sequence: {
      useMaxWidth: false,
      actorFontFamily: fontFamily,
      noteFontFamily: fontFamily,
      messageFontFamily: fontFamily,
      actorFontSize: 14,
      noteFontSize: 14,
      messageFontSize: 14
    }
  };
}
