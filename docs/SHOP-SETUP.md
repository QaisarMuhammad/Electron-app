# GadgetsPOS Desktop: setup guide for shop staff

For the person who sets up or looks after the till. You do not need to be technical. This guide is for version 2.0.0 and uses the
words you see on the screen: **bold** is a button, and "Settings > Printers" means the Settings menu, then Printers.

## Contents

1. [What this program does](#1-what-this-program-does)
2. [The first time you start it](#2-the-first-time-you-start-it)
3. [If it says it cannot connect](#3-if-it-says-it-cannot-connect)
4. [Opening Settings](#4-opening-settings)
5. [Choosing the receipt printer](#5-choosing-the-receipt-printer)
6. [Choosing the label printer](#6-choosing-the-label-printer)
7. [What each test print does](#7-what-each-test-print-does)
8. [The cash drawer](#8-the-cash-drawer)
9. [What the messages mean](#9-what-the-messages-mean)
10. [Other settings](#10-other-settings)
11. [Updating GadgetsPOS](#11-updating-gadgetspos)
12. [If the screen is blank, black or flickers](#12-if-the-screen-is-blank-black-or-flickers)
13. [Getting help](#13-getting-help)

## 1. What this program does

GadgetsPOS Desktop shows your POS on the till computer. It does the things a web page cannot do on its own: it prints receipts and
labels, and it opens the cash drawer. Selling, stock and customers work in the POS as before.

## 2. The first time you start it

1. Open GadgetsPOS from its Desktop or Start menu shortcut.
2. You see the GadgetsPOS logo and "Starting GadgetsPOS...". Then the POS opens. Sign in as usual.
3. If the POS has not appeared after 12 seconds, a line says "This is taking longer than usual. Please check your internet
   connection." If a problem screen appears instead, go to section 3.

**If you used GadgetsPOS 1.x before:** your printer settings and your drawer password are carried over, so you do not set them up
again. Press the test buttons once (sections 5 to 8) to check them. About 20 seconds after the first start, a box asks "Does the
screen look right?". Choose **Yes** if the POS looks normal. Choose **No, use compatibility mode** if the screen is blank, black or
looks broken (section 12). You are only asked once.

**A new till** needs this, in this order:

1. Install your printers in Windows first (the receipt printer and the label printer), as the printer's own instructions say.
2. Open Settings > Printers and choose the receipt printer (section 5). Press **Print test receipt**.
3. Choose the label printer, Zebra or DYMO (section 6). Press **Print test label**.
4. Open Settings > Cash drawer, set the drawer password and test the drawer (section 8).
5. A manager can switch on "Ask for the password before Settings opens", so that nobody else changes the settings.

**The menu bar** at the top of the window:

| Menu | What is in it |
| --- | --- |
| Open Drawer (Ctrl+D) | opens the cash drawer after you type the drawer password |
| View | Reload (Ctrl+R or F5), Force reload, Zoom in, Zoom out, Actual size (Ctrl+0), Toggle full screen (F11) |
| Settings | Printer and Settings... (Ctrl+comma), and the pages Printers, Cash drawer, Connection, General |
| Help | Check for updates..., Open logs folder, Copy diagnostics, Compatibility mode, About GadgetsPOS |
| Quit | closes GadgetsPOS (Ctrl+Q) |

Right-click in the POS for Copy, Paste and similar commands. If the POS page ever looks stuck, press Ctrl+R (or F5) to load it again;
anything on the page that is not saved is lost.

## 3. If it says it cannot connect

GadgetsPOS never shows a blank window. When it cannot open your shop, it shows a screen that says why, and it tries again by itself:
after 3 seconds, then 6, 12 and 24, then about every 30 seconds for as long as the problem lasts. As soon as the connection is back it
opens the POS. You can press **Retry now** at any time.

| The screen says | What it means | What to do |
| --- | --- | --- |
| No internet connection | This computer is not connected to the internet. | Check the network cable, or that Wi-Fi is switched on. If other devices are offline too, restart the router. GadgetsPOS reconnects by itself. |
| Can't find the server | GadgetsPOS could not find the server. The internet may be down, or the server address may be wrong. | Check that this computer is online by opening any website. Check the address with **Change server address**. Wait a moment. |
| The server is not answering | The server turned the connection away. It may be restarting or switched off. | Wait a minute. Check that the server address is correct. If this lasts more than a few minutes, contact your support team. |
| The server is taking too long | The connection is slow, or the server is very busy. | Check that other websites open normally. Restart the router if the internet is slow everywhere. Press **Retry now**, or wait. |
| The secure connection failed | GadgetsPOS could not confirm that the server is safe. This often happens when the date or time on this computer is wrong. | Check the date, time and time zone. Turn on automatic time in the Windows settings. If the problem stays, contact your support team. |
| The server has a problem | The server answered, but it reported an error. This is not a problem with this computer. | Wait a minute. Press **Retry now**. If this lasts more than a few minutes, contact your support team. |
| Can't open GadgetsPOS | Something went wrong while loading the page. | Press **Retry now**. Check your internet connection. If it stays, open **Technical details**, press **Copy details** and send them to your support team. |

The same screen has **Printer settings**, which works even without internet (so you can still check the printers), and **Change server
address**. Support will tell you if the address needs changing.

Other things you may see:

- **A small bar at the top of the POS during the day:** "No internet connection. We'll keep trying — your work on this page is not
  lost." Leave GadgetsPOS open. When the internet returns the bar says "Back online" for a few seconds and disappears.
- **A box: "The page stopped responding."** with **Wait** and **Reload**. Choose **Wait** first. Choose **Reload** if it stays
  stuck, but anything on that page that is not saved will be lost.
- **A screen: "The page stopped responding."** GadgetsPOS loads the page again by itself. If it says "The page keeps stopping. Choose
  View > Reload, or close GadgetsPOS and open it again.", do that.
- **A screen: "The server address leads to ..., which GadgetsPOS does not open. Check the address in Settings > Connection."** The
  server sent you to a website that GadgetsPOS does not trust. Tell your support team; they can correct the address or allow the
  website.
- **A screen: "Not trying again by itself".** Press **Retry now** when you are ready.
- **A box: "Leave this page?"** with **Leave** and **Stay**. Choose **Stay** unless you are sure: changes may not be saved.
- **A box: "GadgetsPOS could not start".** Close it and open GadgetsPOS again. If it keeps happening, contact support.

## 4. Opening Settings

Choose Settings > Printer and Settings... (Ctrl+comma), or choose the page you want from the Settings menu. The Settings window has
five pages: Printers, Cash drawer, Connection, General and About & updates (Help > About GadgetsPOS opens that last one).

If a manager switched on "Ask for the password before Settings opens", a small password window comes first. Type the drawer password.

What you choose on the Printers page applies to this computer only. On a page with a **Save** button, a dot next to the page name and
the words "Unsaved changes" mean that you have changed something and not saved it yet. If you close the Settings window (or quit
GadgetsPOS) while something is unsaved, a box asks "You have unsaved changes. Discard them and close?": **Keep editing** leaves
everything as it is, **Discard changes** closes without saving.

## 5. Choosing the receipt printer

1. Open Settings > Printers. In the **Receipt printer** card keep **Installed printer (recommended)**.
2. In the list **Installed printers**, choose your receipt printer. The list shows every printer installed on this computer.
   - **Default** marks the printer that Windows uses by default.
   - A word such as Ready, Offline, Paused or Out of paper tells you what state Windows says the printer is in.
   - Press **Refresh** if you have just installed or switched on a printer. With more than eight printers there is a search box.
3. Press **Print test receipt**. If you changed something and have not saved yet, GadgetsPOS saves first. You then see a line such
   as "Test receipt sent to EPSON TM-T20." (with "Saved." in front if it saved first).
4. Press **Save**.

"Sent" means GadgetsPOS gave the job to Windows. If nothing comes out, check that the printer is switched on, has paper and shows no
error light, and look at the print queue in Windows.

If a saved printer is no longer installed, it stays in the list with the badge "Not found" and the note "Saved earlier, but this
computer does not list it now." Install it again, or choose another printer.

### Advanced: a port or a network share (Windows only)

Choose **Advanced: port or network share** only for an older setup that prints to a port, or to a shared printer. A shop that used
GadgetsPOS 1.x with a port keeps printing through it after the update, with no action (every kind of port that printed in 1.x is
accepted). Type the address in "Port or shared printer address".

| Accepted | Examples |
| --- | --- |
| A parallel port | `LPT1` to `LPT9` |
| A serial port | `COM1` to `COM256` |
| The `PRN` port | `PRN` |
| A shared printer: two backslashes, the computer's name, one backslash, the share name | `\\localhost\ZebraZD420`, `\\TILL2\Receipts` |

Capital or small letters are fine, and one `:` after a port name is ignored (`LPT1:`). A share name may have spaces. Nothing may come
after the share name.

These are refused: a USB port name such as `USB001`, any file or folder path such as `C:\Receipts\print.txt`, a share with a folder
after it such as `\\TILL2\Receipts\old`, and anything that contains `" ' & | < > ^ % ! , ; =`. GadgetsPOS then says: "This port name
cannot be used. Choose the installed printer, or a shared printer address such as \\localhost\ZebraZD420." For a USB printer, choose
the installed printer instead of a port.

## 6. Choosing the label printer

The POS can print labels in two ways, Zebra or DYMO. The label printer type in **your POS account settings** decides which one it uses.
Set up the kind you use (or both). If your POS account has no label printer type chosen, the POS says: "No label printer type is
chosen. Open Account settings and choose Zebra or DYMO."

### Zebra, or another label printer that understands ZPL

In Settings > Printers, in the **Label printers** card, use the section "Zebra or other raw label printer". Choose the installed
printer, or a port, exactly as for the receipt printer (section 5). Press **Print test label**, then **Save**.

### DYMO

- **DYMO labels need DYMO Connect**, DYMO's own program. It must be installed and running on this computer, with the DYMO printer
  switched on. GadgetsPOS talks to DYMO Connect, not to the printer directly.
- In the section "DYMO printer", the list starts with **Automatic (recommended)**: GadgetsPOS then picks the connected DYMO printer
  for you. Under it is every printer that DYMO Connect knows, with "Connected" or "Not connected". Choose a named printer if you have
  more than one DYMO. If the one you chose cannot be found, GadgetsPOS prints on another connected DYMO printer instead (a
  LabelWriter first), so check that the right printer is switched on.
- A warning note "DYMO Connect is not running" means: open DYMO Connect, make sure the printer is on, then press **Refresh**.
- Press **Print test label**, then **Save**.
- Load the label roll that fits the label layout your shop uses.

## 7. What each test print does

| Button | What comes out |
| --- | --- |
| **Print test receipt** (Receipt printer) | a short slip: GadgetsPOS, "Printer test", the printer's name and "If you can read this, your printer is ready.", then the paper is cut (if the printer has a cutter) |
| **Print test label** (Zebra or other raw label printer) | a small label with the word TEST and a sample barcode |
| **Print test label** (DYMO) | a sample label that says "GadgetsPOS test label", with sample details |
| **Open drawer** (Settings > Cash drawer, "Open drawer (test)") | the cash drawer opens (it asks for the drawer password) |

A test uses what is saved, through the same route as a real receipt or label. If a test fails, the words under the button say what to
do (section 9).

## 8. The cash drawer

### Opening the drawer

Press **Open** in the POS, or choose Open Drawer (Ctrl+D). The window "Open cash drawer" asks for the drawer password. Type it and press
Enter. The window closes and the drawer opens.

The drawer is connected to the receipt printer, and GadgetsPOS opens it by sending the command through that printer, so the receipt
printer must be switched on. A receipt can also carry its own open command; that works without the password, and the settings below do
not change it ("Drawer commands that are part of a receipt are not affected by these settings.").

### Setting or changing the password

- Settings > Cash drawer > **Set password**. Use 4 to 64 characters; a longer password is safer. To change it later press **Change
  password** and type the current password first.
- The password is kept in a protected form. Nobody, support included, can read it back.
- A notice "Your password does not meet the new length rule (4 to 64 characters). Change it when convenient." means your old
  version 1 password is shorter than 4 or longer than 64 characters. It still works. Change it when you can.

### What the lockout means

- After **5 wrong passwords in a row**, every password box in GadgetsPOS pauses for 30 seconds. It says "Too many wrong passwords. Try
  again in 30 seconds." with a countdown.
- Each further wrong password after that doubles the pause: 1 minute, 2 minutes, 4 minutes, then 5 minutes at most.
- A correct password ends it at once.
- It covers every password check together: opening the drawer, opening Settings, changing the password and resetting. Five wrong
  tries anywhere pause them all.
- The count and the pause are kept when GadgetsPOS is closed and opened again, and changing the computer's clock does not end a pause.
  (A pause that is running when GadgetsPOS is closed counts the time it stays closed, by the computer's clock.) The pause slows down
  guessing at the till; it is not a lock on the computer. Keep the computer itself protected too, for example with a Windows password.
- A password of more than 4096 characters is simply a wrong password.

### The drawer settings

Settings > Cash drawer > Drawer settings. Once a drawer password is set, saving these needs it.

| Setting | What it does |
| --- | --- |
| Use the cash drawer | Turn this off if no drawer is connected to the receipt printer. |
| Ask for the password before Settings opens | Stops other people from changing printers or the server address. |
| Drawer pin | Pin 2 is right for most drawers. Choose Pin 5 only if your drawer is wired to pin 5. |
| Pulse length (On time, Off time) | Between 2 and 510 milliseconds. The usual values are 50 and 510. Change them only if the drawer does not open. |

### Testing the drawer

In "Open drawer (test)" type the password and press **Open drawer**. It says "Open command sent. The drawer should open now." If it does
not open, check the cable between the drawer and the receipt printer.

### If you forget the drawer password

There is no other way than this, and that is on purpose: it keeps your drawer safe.

1. Close GadgetsPOS (Quit).
2. Open the GadgetsPOS data folder. In Windows press the Windows key and R together, type `%APPDATA%\Gadgets POS` and press Enter.
   (Settings > About & updates shows the same folder as "Data folder", but you may not be able to open Settings without the password.)
3. Delete the file `config.json`. **This also clears the printer settings, the server address and the allowed domains.** If you can, write
   them down first. The file `config.v1-backup.json`, if there is one, is an old copy and is not used.
4. Start GadgetsPOS. Choose the printers again (sections 5 and 6) and set a new drawer password. If your shop does not use the usual
   server address, enter yours in Settings > Connection.

Deleting `config.json` does not sign you out of the POS. Because anyone who can open that folder can do this, protect the computer
with a Windows password.

## 9. What the messages mean

A failed print or drawer action shows a box from GadgetsPOS with a heading ("The receipt could not be printed", "The label could not
be printed", "The cash drawer did not open" or "GadgetsPOS could not finish that") and the message below it. With the newer POS the
same message appears inside the POS instead. If you print many labels and the printer is switched off, you see one box, not one for
every label: fix the problem, then print again.

### Printing

| Message | What it means | What to do |
| --- | --- | --- |
| No printer is set up yet. Open Settings > Printers, choose your printer and press Save. | No printer is chosen on this computer. | Do what it says. |
| The printer was not found. (or: The printer "name" was not found.) Check that it is switched on and connected, then choose it again in Settings > Printers. | Windows does not list that printer: it is off, unplugged, renamed or removed. | Switch it on, check the cable, press **Refresh** in Settings > Printers and choose it again. |
| The computer could not send the job to the printer. Check that the printer is on, has paper and shows no error light, then try again. | Windows would not take the job. | Check the printer and the print queue in Windows. If it never works on this computer, tell support: GadgetsPOS uses Windows PowerShell to print to installed printers, and some security software blocks it. |
| Nothing could be sent to the printer port. Check the cable or the network share, and the port name in Settings > Printers, then try again. | The port (`LPT`, `COM` or a shared printer) did not accept the job. | Check the cable, or that the computer that shares the printer is on and still shares it. Check the port name. |
| The printer did not answer in time. Check that it is switched on, has paper and is connected, then try again. | The job took longer than 30 seconds. | Check the printer, then try again. |
| This kind of printer connection only works on Windows. In Settings > Printers, choose an installed printer instead. | A port was chosen on a computer that is not Windows. | Choose an installed printer. |
| This port name cannot be used. Choose the installed printer, or a shared printer address such as \\localhost\ZebraZD420. | The port is not one of the accepted forms (section 5). | Choose the installed printer, or correct the port. |
| The printer name cannot be used. Choose the printer again in Settings > Printers. | The saved name has something in it that cannot be used. | Choose the printer again from the list. |
| Choose a printer first. | You pressed **Save** or a test with no printer chosen. | Choose one from the list. |

### DYMO labels

| Message | What it means | What to do |
| --- | --- | --- |
| DYMO label printing is not ready. Check that DYMO Connect is installed and running, then try again. | GadgetsPOS could not reach DYMO Connect. | Start DYMO Connect, then try again. |
| No DYMO printer was found. Check that DYMO Connect is running and the printer is switched on. | DYMO Connect lists no printer. | Switch the printer on and plug it in. Open DYMO Connect. Press **Refresh** in Settings > Printers. |
| The DYMO label could not be printed. Check the label roll and the printer, then try again. (Sometimes: "2 of 5 labels were printed.") | DYMO refused the label. The number says how many came out before it stopped. | Check the roll and the printer, then print the rest. |
| A label layout file is missing. Reinstall GadgetsPOS, or contact support if this keeps happening. | A file that GadgetsPOS ships with is gone. | Contact support to reinstall it. |
| No label printer type is chosen. Open Account settings and choose Zebra or DYMO. | Your POS account does not say which kind of label printer you use. (This message comes from the POS.) | In the POS, open your Account settings and choose Zebra or DYMO. |

### The cash drawer and passwords

| Message | What it means | What to do |
| --- | --- | --- |
| The cash drawer is switched off. A manager can turn it on in Settings > Cash drawer. | "Use the cash drawer" is off. | A manager turns it on. |
| No cash drawer password is set yet. A manager must set one in Settings > Cash drawer before the drawer can be opened. | There is no drawer password yet. | A manager sets one (section 8). |
| That password is not correct. Try again. | A wrong password. | Try again. Five wrong ones in a row start a pause. |
| Too many wrong passwords. Try again in 30 seconds. (or 1 minute, 2 minutes ...) | The lockout of section 8. | Wait for the countdown. |
| The cash drawer did not open. Check the cable between the drawer and the receipt printer, and that the receipt printer is switched on. | The password was right but the open command did not work. | Check the cable and the receipt printer. |
| The password must be 4 to 64 characters long. Choose another one. | A new password is too short or too long. | Choose one of 4 to 64 characters. |
| Enter the password to continue. | The box was empty. | Type the password. |

### Other

| Message | What it means | What to do |
| --- | --- | --- |
| GadgetsPOS received a print request it could not read. Try again. If it keeps happening, restart GadgetsPOS or contact support. | The POS sent something GadgetsPOS could not use. | Try again. Restart GadgetsPOS. Tell support if it repeats. |
| GadgetsPOS blocked this request because it did not come from your POS page. Reload the POS page and try again. | The request came from a page GadgetsPOS does not trust. | Press Ctrl+R to reload the POS. If it keeps happening, tell support. |
| These settings cannot be used. Check the values and try again. | A setting is not valid. | Check what you typed. |
| Updates are not available right now. Check the internet connection and try again later. | The update check failed. | Try again later. |
| Something went wrong. Try again, and contact support if it keeps happening. | Something unexpected. | Try again. Tell support if it repeats, and send them "Copy diagnostics" (section 13). |
| Printing did not work. Check the printer and try again. | The POS got no further explanation from GadgetsPOS. (This message comes from the POS.) | Check the printer, then try again. |
| Opened in your browser: (a website's name) | A link in the POS was opened in your normal web browser, because GadgetsPOS only opens its own sites. | Nothing. |

## 10. Other settings

Settings > General. These are saved as soon as you change them.

| Setting | What it does |
| --- | --- |
| Start GadgetsPOS when this computer starts | The POS opens by itself after the computer is switched on. (Not on Linux.) |
| Start in full screen | Hides the title bar. Press F11 at any time to switch. |
| Keep this computer awake while GadgetsPOS is open | The screen may still turn off. This only stops the computer from going to sleep. |
| Hardware acceleration | Uses the graphics card to draw the screen. Leave it on unless the screen flickers or stays blank (section 12). Changing it needs a restart. |

Settings > Connection shows whether GadgetsPOS is online, has **Reload POS**, and holds the server address and the list of allowed
websites. Leave these to your support team.

Settings > About & updates has **Reset all settings...**. It erases the printer settings, the drawer password, the server address and
the allowed domains on this computer, after you type RESET (and the drawer password, if one is set). Your shop data in the POS is not
touched.

## 11. Updating GadgetsPOS

### 11.0 Updating by hand (how it works for now)

While the installers are not signed, the update feed is not published (`publish.mjs --no-feed`), so an installed GadgetsPOS finds no update and does
not update itself. Each new version is installed by hand, on Windows and on a Mac:

1. Find your version: Settings > About & updates shows "Version x.y.z". The Download Apps page of the dashboard shows the newest version on its download buttons.
2. Finish the sale you are working on and close GadgetsPOS (File > Quit on Windows, Quit GadgetsPOS on a Mac).
3. Download the new installer from the Download Apps page and run it over the old install. Windows: "Windows protected your PC" > More info > Run
   anyway (it asks each time until the app is signed); choose "Only for me" as the first time. Mac: open the new .dmg, drag GadgetsPOS over the old one
   in Applications and click Replace; the first open may need right-click > Open.
4. Open GadgetsPOS and check the version number in Settings > About & updates.

Settings, printers and the drawer password live in the user data folder, which the installer does not touch, so nothing is set up again (checked
in the installer configuration; not yet tried on a real Windows PC: do it once on the test PC, see RELEASE.md section 9). Settings > About & updates
may say the update check did not work: that is expected without a feed and does not affect printing. The customer-facing version of these steps is
the "Updating Gadgets POS" section of the Install guide on the dashboard's Download Apps page.

### 11.1 Automatic updating (when the apps are signed and the feed is published)

GadgetsPOS can update itself.

- It looks for a new version about half a minute after it starts, and then every 4 hours. You can check by hand with Help > Check for
  updates..., or Settings > About & updates > **Check for updates**.
- A new version is downloaded in the background. Keep working.
- When it is ready, a box says "Update ready" with **Restart now** and **Later**. Finish the sale you are working on first, then
  choose **Restart now**: GadgetsPOS closes, installs the update and opens again. If you choose **Later**, the update is installed
  the next time you close GadgetsPOS. Settings > About & updates also has **Restart and install**.
- Windows may ask for an administrator's approval during an update if GadgetsPOS was installed "for all users". When your support team
  installs it, ask them to choose "Only for me".
- Settings > About & updates shows your version number and says "GadgetsPOS is up to date" when there is nothing newer.
- "Automatic updates are off" means this copy cannot update itself. Ask your support team for the newest installer.
- "Couldn't check for updates" means the check failed, usually because there is no internet. Nothing is wrong with the POS.

The first time you move from version 1 to version 2, your support team installs it by hand (version 1 cannot update itself).

## 12. If the screen is blank, black or flickers

GadgetsPOS 2 uses the computer's graphics card to draw the screen, which makes the POS smoother. On some computers (for example one with
an old graphics driver) that can go wrong. There is an easy way back, called **compatibility mode**.

- **GadgetsPOS can switch to it by itself.** If the graphics process stops twice within a minute, or the POS page crashes just after
  GadgetsPOS starts, a box says "The screen had a problem. GadgetsPOS will use compatibility mode." Choose **Restart now**.
- **You can switch to it yourself.** Choose Help > Compatibility mode (it gets a tick), then **Restart now**. This menu is drawn by
  Windows, not by the POS, so it works even when the screen inside the window is blank. Untick it, and restart, to go back.
- **You can also use Settings > General > Hardware acceleration** (switch it off, then **Restart now**), when you can read the screen.
  A note "Compatibility mode is on" then says why.
- **If you cannot see anything at all:** right-click the GadgetsPOS shortcut, choose Properties, and in the **Target** box add a space
  and `--disable-gpu` after the closing quote, so that the end of the box looks like `"...exe" --disable-gpu`. Press OK and start
  GadgetsPOS from that shortcut. This always turns acceleration off, whatever the settings say; Settings will not turn it back on
  while the shortcut has those words ("This shortcut starts GadgetsPOS with --disable-gpu, so hardware acceleration stays off.
  Remove that part from the shortcut first."). To go back to normal, remove the words again.

Compatibility mode draws the screen the way GadgetsPOS 1.x always did. It works everywhere, but scrolling through long lists is not as
smooth. Use it only if the screen needs it.

## 13. Getting help

Send these to your support team:

1. Help > **Copy diagnostics**, then paste into your message. It lists the version, the printers and settings (never the drawer
   password), whether the screen is in compatibility mode, and how long the start took.
2. Help > **Open logs folder**. The newest file is `main.log`. It records what happened, such as "job receipt: ok in 120 ms" or an error
   code, and no passwords, receipts or customer details.
3. What you pressed, and the exact words of any message.

Settings > About & updates also shows the version, the data folder and the logs folder.
