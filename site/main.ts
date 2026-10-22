const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })

interface TypedLine {
  readonly element: HTMLElement
  readonly prompt: HTMLElement | null
  readonly text: string
}

const typedLine = (element: HTMLElement): TypedLine => {
  const prompt = element.querySelector<HTMLElement>(".ps")
  const text = Array.from(element.childNodes)
    .filter((node) => node !== prompt)
    .map((node) => node.textContent ?? "")
    .join("")
  return { element, prompt, text }
}

const renderTyped = (line: TypedLine, count: number, caret: boolean) => {
  line.element.replaceChildren()
  if (line.prompt) line.element.append(line.prompt)
  line.element.append(document.createTextNode(line.text.slice(0, count)))
  if (caret) {
    const mark = document.createElement("span")
    mark.className = "caret"
    mark.setAttribute("aria-hidden", "true")
    line.element.append(mark)
  }
}

const show = (element: Element) => {
  element.classList.remove("is-pending")
  element.classList.add("is-shown")
}

const playScene = async (scene: HTMLElement, signal: AbortSignal) => {
  const typed = Array.from(scene.querySelectorAll<HTMLElement>(".ln[data-type]")).map(typedLine)
  const outputs = Array.from(scene.querySelectorAll<HTMLElement>(".ln[data-out]:not([data-after-tap])"))
  const afterTap = Array.from(scene.querySelectorAll<HTMLElement>(".ln[data-after-tap]"))
  const messages = Array.from(scene.querySelectorAll<HTMLElement>("[data-msg]"))
  const tap = scene.querySelector<HTMLElement>("[data-tap]")

  const reset = () => {
    for (const line of typed) renderTyped(line, line.text.length, false)
    for (const element of [...outputs, ...afterTap, ...messages]) element.classList.remove("is-pending", "is-shown")
    tap?.classList.remove("is-tapped")
  }

  if (reducedMotion.matches) {
    reset()
    tap?.classList.add("is-tapped")
    scene.closest(".demo")?.classList.add("is-ready")
    return
  }

  for (const element of [...outputs, ...afterTap, ...messages]) {
    element.classList.remove("is-shown")
    element.classList.add("is-pending")
  }
  tap?.classList.remove("is-tapped")
  for (const line of typed) renderTyped(line, 0, false)
  scene.closest(".demo")?.classList.add("is-ready")

  try {
    await sleep(280, signal)
    for (const line of typed) {
      const step = line.text.startsWith("#") ? 9 : 24
      for (let count = 1; count <= line.text.length; count++) {
        renderTyped(line, count, true)
        await sleep(line.text[count - 1] === " " ? step * 0.6 : step, signal)
      }
      renderTyped(line, line.text.length, false)
      await sleep(180, signal)
    }
    await sleep(240, signal)
    const [waiting, ...rest] = outputs
    if (tap && waiting) {
      show(waiting)
      await sleep(320, signal)
    }
    for (const message of messages) {
      show(message)
      await sleep(140, signal)
    }
    for (const line of tap ? rest : outputs) {
      await sleep(260, signal)
      show(line)
    }
    if (tap) {
      await sleep(1150, signal)
      tap.classList.add("is-tapped")
      await sleep(360, signal)
      for (const line of afterTap) show(line)
    }
  } catch {
    reset()
  }
}

const setupDemo = (root: HTMLElement) => {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const scenes = new Map(
    tabs.map((tab) => [tab, root.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`)!]),
  )
  let controller: AbortController | undefined

  const select = (tab: HTMLButtonElement, focus: boolean) => {
    controller?.abort()
    controller = new AbortController()
    for (const other of tabs) {
      const selected = other === tab
      other.setAttribute("aria-selected", String(selected))
      other.tabIndex = selected ? 0 : -1
      scenes.get(other)!.hidden = !selected
    }
    if (focus) tab.focus()
    void playScene(scenes.get(tab)!, controller.signal)
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab, false))
    tab.addEventListener("keydown", (event) => {
      const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
      if (event.key === "Home") return select(tabs[0]!, true)
      if (event.key === "End") return select(tabs[tabs.length - 1]!, true)
      if (!offset) return
      event.preventDefault()
      select(tabs[(index + offset + tabs.length) % tabs.length]!, true)
    })
  }

  const start = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    start.disconnect()
    select(tabs[0]!, false)
  }, { threshold: 0.35 })
  start.observe(root)
}

const setupCopy = () => {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "")
        button.textContent = "Copied"
        button.classList.add("is-done")
      } catch {
        button.textContent = "Select it"
      }
      window.setTimeout(() => {
        button.textContent = "Copy"
        button.classList.remove("is-done")
      }, 1400)
    })
  }
}

const demo = document.querySelector<HTMLElement>("[data-demo]")
if (demo) setupDemo(demo)
setupCopy()
