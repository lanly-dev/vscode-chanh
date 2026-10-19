(() => {
  'use strict'

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

  // Header elevation
  const header = $('.site-header')
  const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 8)
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })

  // Mobile navigation
  const navToggle = $('.nav-toggle')
  const navLinks = $('#nav-links')
  navToggle?.addEventListener('click', () => {
    const open = navLinks?.classList.toggle('open')
    navToggle.setAttribute('aria-expanded', String(Boolean(open)))
  })
  $$('.nav-links a').forEach(link => link.addEventListener('click', () => {
    navLinks?.classList.remove('open')
    navToggle?.setAttribute('aria-expanded', 'false')
  }))

  // Reveal on scroll
  const revealables = $$('.reveal')
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
    revealables.forEach(el => observer.observe(el))
  } else {
    revealables.forEach(el => el.classList.add('is-visible'))
  }

  // Copy install command
  $$('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const text = button.getAttribute('data-copy') || ''
      const label = button.querySelector('span')
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        try { document.execCommand('copy') } catch { /* ignore */ }
        area.remove()
      }
      if (label) {
        const original = label.textContent
        label.textContent = 'Copied'
        button.classList.add('copied')
        setTimeout(() => { label.textContent = original; button.classList.remove('copied') }, 1600)
      }
    })
  })

  // YouTube demo link — set this when the video is published.
  // Example: const YOUTUBE_URL = 'https://youtu.be/XXXXXXXXXXX'
  const YOUTUBE_URL = ''
  const youtubeButtons = $$('[data-youtube]')
  const youtubeBadges = $$('[data-youtube-badge]')
  const youtubeNote = $('#youtube-note')
  let youtubeHintTimer = null

  if (YOUTUBE_URL) {
    youtubeButtons.forEach(button => button.setAttribute('aria-label', 'Watch the Chanh demo on YouTube'))
    youtubeBadges.forEach(badge => { badge.textContent = 'Watch on YouTube' })
    const noteText = $('#youtube-note-text')
    if (noteText) {
      const link = document.createElement('a')
      link.href = YOUTUBE_URL
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = 'YouTube'
      noteText.textContent = 'Watch the full 1:57 walkthrough on '
      noteText.append(link, '.')
    }
  }

  function previewDemo() {
    const demo = $('#demo')
    if (demo) demo.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    if (!youtubeNote) return
    youtubeNote.classList.remove('pulse')
    void youtubeNote.offsetWidth
    youtubeNote.classList.add('pulse')
    clearTimeout(youtubeHintTimer)
    youtubeHintTimer = setTimeout(() => youtubeNote.classList.remove('pulse'), 2600)
  }

  youtubeButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (YOUTUBE_URL) {
        window.open(YOUTUBE_URL, '_blank', 'noopener')
      } else {
        previewDemo()
      }
    })
  })

  // Footer year
  const year = $('#year')
  if (year) year.textContent = String(new Date().getFullYear())
})()
