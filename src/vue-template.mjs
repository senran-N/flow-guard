// Vue event directives register handlers for a later user/framework event. They
// are deliberately MEDIUM-confidence candidates, never confirmed invocations.
export function linkVueTemplateEvents(files, addEdge, resolveHandler) {
  for (const file of files) {
    if (file.lang !== "vue") continue;
    const host = file.symbols.find((symbol) => symbol.kind === "module") ||
      file.symbols.find((symbol) => symbol.name === file.defaultExportName && !symbol.parentContainerName);
    if (!host) continue;
    for (const event of file.templateEventHandlers || []) {
      const targets = [...new Map(resolveHandler(file, event.name).map((target) => [target.id, target])).values()]
        .filter((target) => target.id !== host.id && target.zone === host.zone);
      for (const target of targets) addEdge(host.id, target.id, {
        kind: "REGISTRATION",
        evidence: {
          file: file.file,
          line: event.line,
          reason: `Vue 模板事件候选: ${host.name} ➔ ${target.name}`,
          returnFlow: "REGISTERED_REF"
        },
        resolution: { mode: "VUE_TEMPLATE_EVENT", confidence: "MEDIUM" }
      });
    }
  }
}
