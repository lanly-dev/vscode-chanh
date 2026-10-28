(() => {
  'use strict'

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

  /* Table of contents ------------------------------------------------ */
  const allTocLinks = $$('.toc a[href^="#"]')
  const sections = [...new Set(allTocLinks.map(link => link.getAttribute('href').slice(1)))]
    .map(id => document.getElementById(id))
    .filter(Boolean)

  function setActive(id) {
    allTocLinks.forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === `#${id}`)
    })
  }

  function updateActiveSection() {
    if (!sections.length) return
    const offset = window.scrollY + 110
    let current = sections[0]
    for (const section of sections) {
      const top = section.getBoundingClientRect().top + window.scrollY
      if (top <= offset) current = section
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      current = sections[sections.length - 1]
    }
    setActive(current.id)
  }

  let tocTicking = false
  function onTocScroll() {
    if (tocTicking) return
    tocTicking = true
    requestAnimationFrame(() => {
      updateActiveSection()
      tocTicking = false
    })
  }

  updateActiveSection()
  window.addEventListener('scroll', onTocScroll, { passive: true })
  window.addEventListener('resize', onTocScroll)

  allTocLinks.forEach(link => link.addEventListener('click', () => {
    setActive(link.getAttribute('href').slice(1))
    const details = link.closest('details')
    if (details) details.open = false
  }))

  /* Copy buttons ----------------------------------------------------- */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy], [data-copy-target]')
    if (!button) return
    let text = button.dataset.copy
    if (text === undefined) {
      const target = document.querySelector(button.dataset.copyTarget)
      text = target?.innerText ?? target?.textContent ?? ''
    }
    try {
      await copyText(text)
      const label = button.querySelector('span')
      const original = label ? label.textContent : button.textContent
      if (label) label.textContent = 'Copied'
      button.classList.add('copied')
      window.setTimeout(() => {
        if (label) label.textContent = original
        button.classList.remove('copied')
      }, 1600)
    } catch {
      /* Clipboard permissions can fail on file://; leave the selection alone. */
    }
  })

  /* YouTube ------------------------------------------------------------ */
  const YOUTUBE_URL = 'https://youtu.be/o5Q3DKd6uXA'
  const youtubeButtons = $$('[data-youtube]')
  const youtubeNote = $('#youtube-note')

  function pulseDemoNote() {
    if (!youtubeNote) return
    youtubeNote.classList.remove('pulse')
    void youtubeNote.offsetWidth
    youtubeNote.classList.add('pulse')
    window.setTimeout(() => youtubeNote.classList.remove('pulse'), 1700)
  }

  youtubeButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (YOUTUBE_URL) {
        window.open(YOUTUBE_URL, '_blank', 'noopener')
        return
      }
      $('#demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      pulseDemoNote()
    })
  })

  /* Footer ----------------------------------------------------------- */
  const year = $('#year')
  if (year) year.textContent = String(new Date().getFullYear())

  /* Theme toggle ----------------------------------------------------- */
  const themeToggle = $('#theme-toggle')
  const html = document.documentElement
  const THEME_KEY = 'chanh.theme'

  function getSavedTheme() {
    try { return localStorage.getItem(THEME_KEY) } catch { return null }
  }
  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* ignore */ }
  }
  function applyTheme(theme) {
    html.setAttribute('data-theme', theme)
    if (themeToggle) {
      const isLight = theme === 'light'
      themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode')
      themeToggle.setAttribute('title', isLight ? 'Switch to dark mode' : 'Switch to light mode')
    }
  }

  const saved = getSavedTheme()
  const initial = saved ?? 'light'
  applyTheme(initial)

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = html.getAttribute('data-theme') || 'light'
      const next = current === 'light' ? 'dark' : 'light'
      applyTheme(next)
      saveTheme(next)
    })
  }
})()
