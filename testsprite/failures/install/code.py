import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def run_test():
    pw = None
    browser = None
    context = None

    try:
        # Start a Playwright session in asynchronous mode
        pw = await async_api.async_playwright().start()

        # Launch a Chromium browser in headless mode with custom arguments
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process"
            ],
        )

        # Create a new browser context (like an incognito window)
        context = await browser.new_context()
        # Wider default timeout to match the agent's DOM-stability budget;
        # auto-waiting Playwright APIs (expect, locator.wait_for) inherit this.
        context.set_default_timeout(15000)

        # Open a new page in the browser context
        page = await context.new_page()

        # Interact with the page elements to simulate user flow
        # -> navigate
        await page.goto("https://ai-mind-map-website.vercel.app")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Click the 'Install' link in the top navigation to open the Install page.
        # Install link
        elem = page.get_by_text('🧠 AI Mind Map', exact=True).locator("xpath=ancestor-or-self::*[.//a][1]").get_by_role('link', name='Install', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Claude Code' button
        # 🤖 Claude Code Supported button
        elem = page.get_by_role('button', name='🤖 Claude Code Supported', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Cursor' agent button in the Choose Your Agent grid to switch the displayed install command to Cursor-specific instructions.
        # 🎯 Cursor Supported button
        elem = page.get_by_role('button', name='🎯 Cursor Supported', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Copy' button for the install command and verify the page shows visual feedback such as 'Copied!' or a checkmark confirming the copy action.
        # Copy button
        elem = page.locator('[id="copy-install"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'Copy' button next to the install command and verify the UI shows a confirmation message such as 'Copied' or a checkmark.
        # Copy button
        elem = page.locator('[id="copy-install"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'Copy' button next to the install command and verify the page shows visual feedback such as 'Copied' or a checkmark.
        # Copy button
        elem = page.locator('[id="copy-install"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'Copy' button next to the install command and verify the page shows visible confirmation such as 'Copied' or a checkmark.
        # Copy button
        elem = page.locator('[id="copy-install"]')
        await elem.click(timeout=10000)
        
        # -> Click the 'Copy' button next to the 'npx ai-mind-map install' command and verify the UI shows a visible 'Copied' confirmation or that the button text changes to indicate success.
        # Copy button
        elem = page.locator('[id="copy-install"]')
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the page shows an install guide heading and multiple agent selection buttons including at least Claude and Cursor
        await page.locator("xpath=/html/body/section[1]/div[2]/button[1]").nth(0).scroll_into_view_if_needed()
        # Assert: Expected the Claude Code agent button to be visible.
        await expect(page.locator("xpath=/html/body/section[1]/div[2]/button[1]").nth(0)).to_be_visible(timeout=15000), "Expected the Claude Code agent button to be visible."
        await page.locator("xpath=/html/body/section[1]/div[2]/button[2]").nth(0).scroll_into_view_if_needed()
        # Assert: Expected the Cursor agent button to be visible.
        await expect(page.locator("xpath=/html/body/section[1]/div[2]/button[2]").nth(0)).to_be_visible(timeout=15000), "Expected the Cursor agent button to be visible."
        await page.locator("xpath=/html/body/section[1]/div[2]").nth(0).scroll_into_view_if_needed()
        # Assert: Expected the agent selection area to be visible and list agent buttons.
        await expect(page.locator("xpath=/html/body/section[1]/div[2]").nth(0)).to_be_visible(timeout=15000), "Expected the agent selection area to be visible and list agent buttons."
        
        # --> Verify a code block with an install command is visible on the page
        await page.locator("xpath=/html/body/section[2]/div[1]").nth(0).scroll_into_view_if_needed()
        # Assert: Expected the install code block to be visible on the page.
        await expect(page.locator("xpath=/html/body/section[2]/div[1]").nth(0)).to_be_visible(timeout=15000), "Expected the install code block to be visible on the page."
        # Assert: Expected the install code block to contain the install command 'npx ai-mind-map install'.
        await expect(page.locator("xpath=/html/body/section[2]/div[1]").nth(0)).to_contain_text("npx ai-mind-map install", timeout=15000), "Expected the install code block to contain the install command 'npx ai-mind-map install'."
        
        # --> Verify the install command updates to show the Claude-specific configuration or mentions 'claude' in the command or config snippet
        # Assert: Expected the install command block to mention "claude".
        await expect(page.locator("xpath=/html/body/section[2]/div[1]").nth(0)).to_contain_text("claude", timeout=15000), "Expected the install command block to mention \"claude\"."
        # Assert: Expected the generated config view to mention "claude".
        await expect(page.locator("xpath=/html/body/section[2]/div[2]").nth(0)).to_contain_text("claude", timeout=15000), "Expected the generated config view to mention \"claude\"."
        
        # --> Verify the install command updates and now shows Cursor-specific configuration, different from the Claude command
        # Assert: Expected the install command block to show the Cursor-specific install command.
        await expect(page.locator("xpath=/html/body/section[2]/div[1]").nth(0)).to_have_text("npx ai-mind-map install --agent=cursor", timeout=15000), "Expected the install command block to show the Cursor-specific install command."
        # Assert: Expected the generated config to include a Cursor-specific JSON key "cursor".
        await expect(page.locator("xpath=/html/body/section[2]/div[2]").nth(0)).to_contain_text("\"cursor\"", timeout=15000), "Expected the generated config to include a Cursor-specific JSON key \"cursor\"."
        
        # --> Verify the copy button gives visual feedback (e.g. changes text to 'Copied!' or shows a checkmark) confirming the command was copied
        # Assert: Expected the install command area to show 'Copied' confirmation text after clicking the copy button.
        await expect(page.locator("xpath=/html/body/section[2]/div[1]").nth(0)).to_contain_text("Copied", timeout=15000), "Expected the install command area to show 'Copied' confirmation text after clicking the copy button."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    