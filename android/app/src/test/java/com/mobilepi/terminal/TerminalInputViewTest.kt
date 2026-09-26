package com.mobilepi.terminal

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalInputViewTest {

  @Test
  fun `native input applies sticky control and alt modifiers`() {
    assertEquals("\u0018", applyTerminalInputModifiers("x", ctrlActive = true, altActive = false))
    assertEquals("\u001bm", applyTerminalInputModifiers("m", ctrlActive = false, altActive = true))
    assertEquals("\u001b\u0000", applyTerminalInputModifiers(" ", ctrlActive = true, altActive = true))
    assertEquals("\u007f", applyTerminalInputModifiers("?", ctrlActive = true, altActive = false))
  }

  @Test
  fun `native input leaves ordinary text unchanged without modifiers`() {
    assertEquals("model", applyTerminalInputModifiers("model", ctrlActive = false, altActive = false))
    assertEquals("é🙂", applyTerminalInputModifiers("é🙂", ctrlActive = true, altActive = false))
  }

  @Test
  fun `hardware enter sends one return across key down and key up`() {
    assertEquals(true, editorReturnAction(EditorInfo.IME_ACTION_SEND, KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_DOWN))
    assertEquals(false, editorReturnAction(EditorInfo.IME_NULL, KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_UP))
  }

  @Test
  fun `ime send without a key event sends once and other actions pass through`() {
    assertEquals(true, editorReturnAction(EditorInfo.IME_ACTION_SEND, null, null))
    assertNull(editorReturnAction(EditorInfo.IME_ACTION_NEXT, null, null))
  }
}
