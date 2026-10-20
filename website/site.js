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

  /* YouTube placeholder ---------------------------------------------- */
  const YOUTUBE_URL = ''
  const youtubeButtons = $$('[data-youtube]')
  const youtubeBadges = $$('[data-youtube-badge]')
  const youtubeNote = $('#youtube-note')
  const youtubeNoteText = $('#youtube-note-text')

  if (YOUTUBE_URL) {
    youtubeButtons.forEach(button => button.setAttribute('aria-label', 'Watch the Chanh demo on YouTube'))
    youtubeBadges.forEach(badge => { badge.textContent = 'Watch on YouTube' })
    if (youtubeNoteText) {
      const link = document.createElement('a')
      link.href = YOUTUBE_URL
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = 'YouTube'
      youtubeNoteText.textContent = 'Watch the full UI walkthrough on '
      youtubeNoteText.append(link, '.')
    }
  }

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
      } else {
        $('#demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        pulseDemoNote()
      }
    })
  })

  /* Footer ----------------------------------------------------------- */
  const year = $('#year')
  if (year) year.textContent = String(new Date().getFullYear())
})()
