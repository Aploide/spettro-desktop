// The safety catch the approval and question cards share.
//
// A card turns up while the user is doing something else — typing the next
// message, working in the terminal, reaching for a button. Nothing typed or
// clicked for something else may answer it. So a card:
//   - ignores every key and click for ARM_DELAY_MS after it appears;
//   - after that, hears its keys only while focus is on the card itself or
//     somewhere nothing is typed (the transcript, the page) — never while
//     focus is in the composer, the terminal or any other field;
//   - never treats Enter as approval at all (PermissionCard).
// From the composer, Tab moves focus onto the card ("Press Tab to review").

import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { ARM_DELAY_MS, isTypingTarget } from './prompts'

/** True once the card has been up for ARM_DELAY_MS. The ref reads the same
 *  value without waiting for a render, for handlers. */
export function useArmed(): { armed: boolean; armedRef: MutableRefObject<boolean> } {
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(false)
  useEffect(() => {
    const id = setTimeout(() => {
      armedRef.current = true
      setArmed(true)
    }, ARM_DELAY_MS)
    return () => clearTimeout(id)
  }, [])
  return { armed, armedRef }
}

/** The focused element, kept current as focus moves. */
export function useActiveElement(): Element | null {
  const [active, setActive] = useState<Element | null>(() => document.activeElement)
  useEffect(() => {
    const update = (): void => setActive(document.activeElement)
    // focusout fires before the next element takes focus; read it after.
    const later = (): void => void setTimeout(update, 0)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', later)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', later)
    }
  }, [])
  return active
}

/** Something else is in front of the chat: a modal, a dialog (the image
 *  viewer is one without aria-modal), a menu, a popover. Its keys are its
 *  own. */
function overlayOver(card: Element): boolean {
  const overlays = document.querySelectorAll(
    '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .popover--portal'
  )
  return Array.from(overlays).some((o) => !o.contains(card))
}

/**
 * Whether a key event may drive this card: armed, and either aimed at the
 * card or typed where nothing is being typed, with nothing open in front.
 */
export function keyIsForCard(event: KeyboardEvent, card: Element | null, armed: boolean): boolean {
  if (!armed || !card || event.defaultPrevented) return false
  if (event.isComposing) return false
  const target = event.target instanceof Element ? event.target : null
  if (target && card.contains(target)) return true
  if (isTypingTarget(target)) return false
  return !overlayOver(card)
}

/** Whether the card's digit keys are live right now, for drawing the key
 *  hints. */
export function keysLive(card: Element | null, active: Element | null, armed: boolean): boolean {
  if (!armed || !card) return false
  // In the card's own text field the digits are text, so no hints there.
  return !isTypingTarget(active)
}

/** Whether focus is in the chat's composer, where Tab reaches the card. */
export function inComposer(active: Element | null): boolean {
  return active instanceof Element && active.closest('.composer-input') !== null
}
