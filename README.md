[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/matteoantoci-google-forms-mcp-badge.png)](https://mseep.ai/app/matteoantoci-google-forms-mcp)

# Google Forms MCP Server

This MCP server uses the Google Forms API to provide functions such as creating, editing, and retrieving responses for forms.

## Build Method

### Initial Setup
This project uses [pnpm](https://pnpm.io/). After cloning the repository, install dependencies:
```
cd google-forms-mcp
pnpm install
```

The `packageManager` field pins the pnpm version, so `corepack enable` is enough to get
the right one. Note that pnpm is required rather than optional here: the dependency
overrides that keep the tree free of known vulnerabilities live under the `pnpm.overrides`
key, which npm does not read.

### Build the Server
```
# Build the main MCP server
pnpm run build
```

### Build the Refresh Token Acquisition Script
```
# Build the refresh token acquisition script
pnpm run build:token
```

### Execution in Development Environment
```
# Run the server directly
node build/index.js

# Or, use the pnpm script
pnpm run start
```


## Setup Method

1. Create a project in Google Cloud Console and enable the Google Forms API.
   - https://console.cloud.google.com/
   - Search for "Google Forms API" from APIs & Services > Library and enable it.

2. Obtain OAuth 2.0 Client ID and Secret.
   - APIs & Services > Credentials > Create Credentials > OAuth client ID
   - Select Application type: "Desktop app"

3. Set environment variables and obtain the refresh token.
   ```bash
   export GOOGLE_CLIENT_ID="YOUR_CLIENT_ID"
   export GOOGLE_CLIENT_SECRET="YOUR_CLIENT_SECRET"
   cd google-forms-mcp
   pnpm run build
   node build/get-refresh-token.js
   ```

   Note: If an error occurs when running get-refresh-token.js, execute the following command:
   ```bash
   cd google-forms-mcp
   pnpm run build:token
   node build/get-refresh-token.js
   ```

4. Copy the displayed refresh token.

   > **Upgrading from an earlier version?** The OAuth scope was narrowed from
   > `auth/drive` (full read/write/delete access to your entire Google Drive) to
   > `auth/drive.file` (only files this app creates). Refresh tokens issued before
   > this change still carry the broader scope. Revoke the old token at
   > [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
   > and re-run the steps above to issue a correctly scoped one.

5. Update the Claude desktop app's configuration file.
   - Open `~/Library/Application Support/Claude/claude_desktop_config.json`.
   - Add environment variables to the `google-forms-mcp` in the `mcpServers` section:
   ```json
   "google-forms-mcp": {
     "command": "node",
     "args": [
       "/path/to/your/google-forms-mcp/build/index.js" # Update this path
     ],
     "env": {
       "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID",
       "GOOGLE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
       "GOOGLE_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
     }
   }
   ```

6. Restart the Claude desktop app.

## Available Tools

This MCP server provides the following tools:

| Tool | Purpose |
|---|---|
| `create_form` | Create a new form. Accepts `description` and a full `items` array, so a whole questionnaire can be built in one call. |
| `add_items` | Add several items in one batch, appended in the order given. Returns the `itemId` of each. |
| `add_text_question` | Add a single text question (`paragraph: true` for a long answer). |
| `add_multiple_choice_question` | Add a single choice question — `type` is `RADIO` (default), `CHECKBOX` or `DROP_DOWN`. |
| `add_page_break` | Add a section break. Its `itemId` is the branching target. |
| `update_item` | Replace the item at a given index. |
| `delete_item` | Delete the item at a given index. |
| `move_item` | Reorder an item. |
| `update_form_info` | Change title, description or Drive file name. |
| `update_settings` | Toggle quiz mode. |
| `get_form` | Compact outline of the form; `verbose: true` returns the raw API JSON. |
| `get_form_responses` | Get form responses. |

### Item types

`TEXT`, `PARAGRAPH`, `RADIO`, `CHECKBOX`, `DROP_DOWN`, `SCALE`, `DATE`, `TIME`,
`RATING`, `FILE_UPLOAD`, `GRID`, `CHECKBOX_GRID`, `PAGE_BREAK`, `TEXT_BLOCK`.

Every item takes `title`, `description` (the grey help text under the title) and
`required`. Choices are plain strings, or objects when you need more:

```json
{
  "type": "CHECKBOX",
  "title": "Which of these do you use?",
  "description": "Select all that apply",
  "options": ["Email", "Chat", { "isOther": true }]
}
```

### Ordering

Items are appended at the end of the form. Every tool that adds items also takes
an optional `index` to insert somewhere specific. Adding a list through
`create_form` or `add_items` is a single atomic `batchUpdate`, so the items land
in exactly the order given — prefer it over a sequence of single-question calls.

### Branching

A choice option can carry `goToSectionId` (the `itemId` of a `PAGE_BREAK`) or
`goToAction` (`NEXT_SECTION`, `RESTART_FORM`, `SUBMIT_FORM`). `SUBMIT_FORM` is
how a screening question disqualifies a respondent.

The Forms API only supports branching **from a choice option** — a section
cannot declare its own default next section. So the question that routes has to
be the last one in its section.

## Usage Example

```
Create a form and add some questions.
```

Claude uses MCP tools like the following to create the form:

1. Use `create_form` with an `items` array to create the whole form in one call
2. Use `add_items` to append more items, or `update_item` / `move_item` / `delete_item` to revise them
3. Display the `responderUri` (to share) and `editUri` (to edit) returned by the tools
