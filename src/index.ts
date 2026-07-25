#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Request
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// Get authentication information from environment variables
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN environment variables are required');
}

const CHOICE_TYPES = ['RADIO', 'CHECKBOX', 'DROP_DOWN'];
const GO_TO_ACTIONS = ['NEXT_SECTION', 'RESTART_FORM', 'SUBMIT_FORM'];

// A single choice. Plain strings cover the common case; the object form is what
// you need for the "Other" write-in option and for branching to a section.
const OPTION_SCHEMA = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Choice text' },
        isOther: {
          type: 'boolean',
          description: 'Makes this the "Other" option, which renders a free-text field',
        },
        goToAction: {
          type: 'string',
          enum: GO_TO_ACTIONS,
          description: 'Where to send the respondent who picks this choice. SUBMIT_FORM ends the form — this is how you disqualify in a screener.',
        },
        goToSectionId: {
          type: 'string',
          description: 'itemId of the PAGE_BREAK item to jump to when this choice is picked. Mutually exclusive with goToAction.',
        },
      },
    },
  ],
  description: 'A choice: either a string, or an object for "Other" / branching',
};

// One form item. Shared by create_form, add_items and update_item so the shape
// of a question is described in exactly one place.
const ITEM_SPEC_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'TEXT', 'PARAGRAPH', 'RADIO', 'CHECKBOX', 'DROP_DOWN', 'SCALE',
        'DATE', 'TIME', 'RATING', 'FILE_UPLOAD', 'GRID', 'CHECKBOX_GRID',
        'PAGE_BREAK', 'TEXT_BLOCK',
      ],
      description: 'Item type. CHECKBOX is the multi-select one. PAGE_BREAK starts a new section (its itemId is what goToSectionId points at). TEXT_BLOCK is a text-only block with no question.',
    },
    title: { type: 'string', description: 'Question text, or section title for PAGE_BREAK' },
    description: {
      type: 'string',
      description: 'Help text shown in grey under the title. Put instructions like "select all that apply" here, not in the title.',
    },
    required: { type: 'boolean', description: 'Whether an answer is mandatory (default false)' },
    options: {
      type: 'array',
      items: OPTION_SCHEMA,
      description: 'Choices for RADIO / CHECKBOX / DROP_DOWN',
    },
    shuffle: { type: 'boolean', description: 'Randomize choice order (choice questions)' },
    low: { type: 'number', description: 'SCALE: lowest value (0 or 1)' },
    high: { type: 'number', description: 'SCALE: highest value (2 to 10)' },
    lowLabel: { type: 'string', description: 'SCALE: label for the low end' },
    highLabel: { type: 'string', description: 'SCALE: label for the high end' },
    includeTime: { type: 'boolean', description: 'DATE: also ask for a time' },
    includeYear: { type: 'boolean', description: 'DATE: also ask for a year (default true)' },
    duration: { type: 'boolean', description: 'TIME: ask for a duration instead of a time of day' },
    ratingScaleLevel: { type: 'number', description: 'RATING: number of icons (3 to 10)' },
    iconType: {
      type: 'string',
      description: 'RATING: icon, e.g. STAR, HEART, THUMB_UP',
    },
    folderId: { type: 'string', description: 'FILE_UPLOAD: Drive folder ID that receives the uploads' },
    types: { type: 'array', items: { type: 'string' }, description: 'FILE_UPLOAD: allowed file types' },
    maxFiles: { type: 'number', description: 'FILE_UPLOAD: max number of files' },
    maxFileSize: { type: 'string', description: 'FILE_UPLOAD: max bytes per file, as a string' },
    rows: {
      type: 'array',
      items: { type: 'string' },
      description: 'GRID / CHECKBOX_GRID: row labels (one sub-question each)',
    },
    columns: {
      type: 'array',
      items: { type: 'string' },
      description: 'GRID / CHECKBOX_GRID: column labels (the shared answer scale)',
    },
    shuffleQuestions: { type: 'boolean', description: 'GRID / CHECKBOX_GRID: randomize row order' },
  },
  required: ['type'],
};

class GoogleFormsServer {
  private server: Server;
  private oauth2Client: OAuth2Client;
  private forms: any;

  constructor() {
    this.server = new Server(
      {
        name: 'google-forms-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize OAuth2 client
    this.oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET
    );
    this.oauth2Client.setCredentials({
      refresh_token: REFRESH_TOKEN
    });

    // Initialize Google Forms API
    this.forms = google.forms({
      version: 'v1',
      auth: this.oauth2Client
    });

    this.setupToolHandlers();

    // Error handling
    // Log only the message: googleapis errors carry the request config, whose
    // headers include the OAuth bearer token, and stderr is persisted to the
    // MCP client's log files.
    this.server.onerror = (error: Error) => console.error('[MCP Error]', error.message);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_form',
          description:
            'Create a new Google Form. Pass `items` to build the whole form in one call — that is the cheapest and safest way to do it, since the items land in exactly the order given.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Form title',
              },
              description: {
                type: 'string',
                description: 'Form description, shown under the title (optional)',
              },
              documentTitle: {
                type: 'string',
                description: 'Drive file name (optional, defaults to title)',
              },
              items: {
                type: 'array',
                items: ITEM_SPEC_SCHEMA,
                description: 'Items to add, in display order (optional)',
              },
            },
            required: ['title'],
          },
        },
        {
          name: 'add_items',
          description:
            'Add several items to a form in one batch. Items are appended in the order given, at the end of the form unless `index` says otherwise. Prefer this over repeated single-question calls: it is one round-trip, it is atomic, and the ordering is deterministic. Returns the itemId of each created item, which you need for goToSectionId branching.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              items: {
                type: 'array',
                items: ITEM_SPEC_SCHEMA,
                description: 'Items to add, in display order',
              },
              index: {
                type: 'number',
                description: 'Position of the first new item. Defaults to the end of the form.',
              },
            },
            required: ['formId', 'items'],
          },
        },
        {
          name: 'add_text_question',
          description: 'Add a single text question to the form. Appended at the end unless `index` is given.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              },
              questionTitle: {
                type: 'string',
                description: 'Question title',
              },
              description: {
                type: 'string',
                description: 'Help text shown under the title (optional)',
              },
              paragraph: {
                type: 'boolean',
                description: 'Long answer instead of a single line (optional, default false)',
              },
              required: {
                type: 'boolean',
                description: 'Whether required (optional, default is false)',
              },
              index: {
                type: 'number',
                description: 'Position in the form. Defaults to the end.',
              },
            },
            required: ['formId', 'questionTitle'],
          },
        },
        {
          name: 'add_multiple_choice_question',
          description:
            'Add a single choice question to the form. Set `type` to CHECKBOX for multi-select or DROP_DOWN for a dropdown; the default is RADIO. Appended at the end unless `index` is given.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              },
              questionTitle: {
                type: 'string',
                description: 'Question title',
              },
              options: {
                type: 'array',
                items: OPTION_SCHEMA,
                description: 'Array of choices',
              },
              type: {
                type: 'string',
                enum: CHOICE_TYPES,
                description: 'RADIO (default), CHECKBOX for multi-select, or DROP_DOWN',
              },
              description: {
                type: 'string',
                description: 'Help text shown under the title (optional)',
              },
              shuffle: {
                type: 'boolean',
                description: 'Randomize choice order (optional)',
              },
              required: {
                type: 'boolean',
                description: 'Whether required (optional, default is false)',
              },
              index: {
                type: 'number',
                description: 'Position in the form. Defaults to the end.',
              },
            },
            required: ['formId', 'questionTitle', 'options'],
          },
        },
        {
          name: 'add_page_break',
          description:
            'Add a section break. Returns its itemId, which choice options use as goToSectionId to branch. Note: the Forms API only supports branching from a choice option — a section cannot declare its own default next section, so the question that routes must sit at the end of its section.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              title: { type: 'string', description: 'Section title (optional)' },
              description: { type: 'string', description: 'Section description (optional)' },
              index: {
                type: 'number',
                description: 'Position in the form. Defaults to the end.',
              },
            },
            required: ['formId'],
          },
        },
        {
          name: 'update_item',
          description:
            'Replace an existing item at a given index. Use get_form first to find the index. By default every field present in the new spec is updated.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              index: { type: 'number', description: 'Index of the item to update' },
              item: { ...ITEM_SPEC_SCHEMA, description: 'The new item definition' },
              updateMask: {
                type: 'string',
                description: 'Comma-separated fields to update, e.g. "title,questionItem". Defaults to the fields present in `item`.',
              },
            },
            required: ['formId', 'index', 'item'],
          },
        },
        {
          name: 'delete_item',
          description: 'Delete the item at the given index. Indexes of later items shift down by one.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              index: { type: 'number', description: 'Index of the item to delete' },
            },
            required: ['formId', 'index'],
          },
        },
        {
          name: 'move_item',
          description: 'Move the item at `fromIndex` to `toIndex`. Use this to fix ordering instead of rebuilding the form.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              fromIndex: { type: 'number', description: 'Current index of the item' },
              toIndex: { type: 'number', description: 'Index to move it to' },
            },
            required: ['formId', 'fromIndex', 'toIndex'],
          },
        },
        {
          name: 'update_form_info',
          description: 'Update the form title, description or Drive file name.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              title: { type: 'string', description: 'New form title (optional)' },
              description: { type: 'string', description: 'New form description (optional)' },
              documentTitle: { type: 'string', description: 'New Drive file name (optional)' },
            },
            required: ['formId'],
          },
        },
        {
          name: 'update_settings',
          description: 'Update form settings. Currently the Forms API only exposes quiz mode.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: { type: 'string', description: 'Form ID' },
              isQuiz: { type: 'boolean', description: 'Whether the form is a quiz' },
            },
            required: ['formId', 'isQuiz'],
          },
        },
        {
          name: 'get_form',
          description:
            'Get the form as a compact outline: one line per item with its index, itemId, type, title and choices. Pass verbose:true for the raw API JSON.',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              },
              verbose: {
                type: 'boolean',
                description: 'Return the full raw API response instead of the outline (optional, default false)',
              },
            },
            required: ['formId'],
          },
        },
        {
          name: 'get_form_responses',
          description: 'Get form responses',
          inputSchema: {
            type: 'object',
            properties: {
              formId: {
                type: 'string',
                description: 'Form ID',
              }
            },
            required: ['formId'],
          },
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        switch (request.params.name) {
          case 'create_form':
            return await this.createForm(request.params.arguments);
          case 'add_items':
            return await this.addItems(request.params.arguments);
          case 'add_text_question':
            return await this.addTextQuestion(request.params.arguments);
          case 'add_multiple_choice_question':
            return await this.addMultipleChoiceQuestion(request.params.arguments);
          case 'add_page_break':
            return await this.addPageBreak(request.params.arguments);
          case 'update_item':
            return await this.updateItem(request.params.arguments);
          case 'delete_item':
            return await this.deleteItem(request.params.arguments);
          case 'move_item':
            return await this.moveItem(request.params.arguments);
          case 'update_form_info':
            return await this.updateFormInfo(request.params.arguments);
          case 'update_settings':
            return await this.updateSettings(request.params.arguments);
          case 'get_form':
            return await this.getForm(request.params.arguments);
          case 'get_form_responses':
            return await this.getFormResponses(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: any) {
        console.error('Error in tool execution:', error?.message || 'Unknown error');
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private ok(payload: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private editUri(formId: string) {
    return `https://docs.google.com/forms/d/${formId}/edit`;
  }

  private requireString(value: any, name: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new McpError(ErrorCode.InvalidParams, `${name} is required`);
    }
    return value;
  }

  private requireIndex(value: any, name: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new McpError(ErrorCode.InvalidParams, `${name} must be a non-negative integer`);
    }
    return value;
  }

  /** Number of items currently in the form — i.e. the index that appends. */
  private async itemCount(formId: string): Promise<number> {
    const form = await this.forms.forms.get({ formId });
    return form.data.items?.length ?? 0;
  }

  private async resolveIndex(formId: string, index: any): Promise<number> {
    if (index === undefined || index === null) {
      return await this.itemCount(formId);
    }
    return this.requireIndex(index, 'index');
  }

  private async batchUpdate(formId: string, requests: any[]) {
    const response = await this.forms.forms.batchUpdate({
      formId,
      requestBody: { requests },
    });
    return response.data;
  }

  private buildChoiceOptions(options: any, where: string): any[] {
    if (!Array.isArray(options) || options.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `"${where}": options must be a non-empty array`
      );
    }

    return options.map((option: any, i: number) => {
      if (typeof option === 'string') {
        return { value: option };
      }
      if (!option || typeof option !== 'object') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `"${where}": option ${i} must be a string or an object`
        );
      }

      const built: any = {};
      if (option.isOther) {
        built.isOther = true;
        // The "Other" choice carries no author-supplied text; the respondent
        // types it. Only pass a value through if the caller insisted on one.
        if (typeof option.value === 'string' && option.value !== '') {
          built.value = option.value;
        }
      } else {
        built.value = this.requireString(option.value, `"${where}": option ${i} value`);
      }

      if (option.goToAction && option.goToSectionId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `"${where}": option ${i} cannot set both goToAction and goToSectionId`
        );
      }
      if (option.goToAction) {
        if (!GO_TO_ACTIONS.includes(option.goToAction)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `"${where}": option ${i} goToAction must be one of ${GO_TO_ACTIONS.join(', ')}`
          );
        }
        built.goToAction = option.goToAction;
      }
      if (option.goToSectionId) {
        built.goToSectionId = option.goToSectionId;
      }
      return built;
    });
  }

  /** Turn an item spec into a Google Forms API Item. */
  private buildItem(spec: any): any {
    if (!spec || typeof spec !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Each item must be an object');
    }

    const type = String(spec.type ?? 'TEXT').toUpperCase();
    const label = spec.title ?? `<${type}>`;
    const item: any = {};

    if (spec.title !== undefined) item.title = spec.title;
    if (spec.description !== undefined) item.description = spec.description;

    // Items that are not questions.
    if (type === 'PAGE_BREAK') {
      item.pageBreakItem = {};
      return item;
    }
    if (type === 'TEXT_BLOCK') {
      item.textItem = {};
      return item;
    }

    if (item.title === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `A ${type} item needs a title`);
    }

    if (type === 'GRID' || type === 'CHECKBOX_GRID') {
      return this.buildGridItem(item, spec, type, label);
    }

    const question: any = { required: spec.required ?? false };

    switch (type) {
      case 'TEXT':
        question.textQuestion = {};
        break;
      case 'PARAGRAPH':
        question.textQuestion = { paragraph: true };
        break;
      case 'RADIO':
      case 'CHECKBOX':
      case 'DROP_DOWN':
        question.choiceQuestion = {
          type,
          options: this.buildChoiceOptions(spec.options, label),
        };
        if (spec.shuffle) question.choiceQuestion.shuffle = true;
        break;
      case 'SCALE':
        if (typeof spec.low !== 'number' || typeof spec.high !== 'number') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `"${label}": SCALE needs numeric low and high`
          );
        }
        question.scaleQuestion = { low: spec.low, high: spec.high };
        if (spec.lowLabel !== undefined) question.scaleQuestion.lowLabel = spec.lowLabel;
        if (spec.highLabel !== undefined) question.scaleQuestion.highLabel = spec.highLabel;
        break;
      case 'DATE':
        question.dateQuestion = {
          includeTime: spec.includeTime ?? false,
          includeYear: spec.includeYear ?? true,
        };
        break;
      case 'TIME':
        question.timeQuestion = { duration: spec.duration ?? false };
        break;
      case 'RATING':
        if (typeof spec.ratingScaleLevel !== 'number' || !spec.iconType) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `"${label}": RATING needs ratingScaleLevel and iconType`
          );
        }
        question.ratingQuestion = {
          ratingScaleLevel: spec.ratingScaleLevel,
          iconType: spec.iconType,
        };
        break;
      case 'FILE_UPLOAD':
        question.fileUploadQuestion = {
          folderId: this.requireString(spec.folderId, `"${label}": folderId`),
        };
        if (spec.types !== undefined) question.fileUploadQuestion.types = spec.types;
        if (spec.maxFiles !== undefined) question.fileUploadQuestion.maxFiles = spec.maxFiles;
        if (spec.maxFileSize !== undefined) {
          question.fileUploadQuestion.maxFileSize = String(spec.maxFileSize);
        }
        break;
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown item type: ${spec.type}`);
    }

    item.questionItem = { question };
    return item;
  }

  private buildGridItem(item: any, spec: any, type: string, label: string): any {
    if (!Array.isArray(spec.rows) || spec.rows.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `"${label}": a grid needs a rows array`);
    }

    item.questionGroupItem = {
      questions: spec.rows.map((row: any) => ({
        required: spec.required ?? false,
        rowQuestion: { title: this.requireString(row, `"${label}": row`) },
      })),
      grid: {
        columns: {
          type: type === 'CHECKBOX_GRID' ? 'CHECKBOX' : 'RADIO',
          options: this.buildChoiceOptions(spec.columns, `${label} (columns)`),
        },
      },
    };
    if (spec.shuffleQuestions) {
      item.questionGroupItem.grid.shuffleQuestions = true;
    }
    return item;
  }

  private buildCreateRequests(items: any, startIndex: number): any[] {
    if (!Array.isArray(items) || items.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'items must be a non-empty array');
    }
    return items.map((spec: any, i: number) => ({
      createItem: {
        item: this.buildItem(spec),
        location: { index: startIndex + i },
      },
    }));
  }

  /** Pair each createItem reply with the spec that produced it. */
  private summarizeCreated(data: any, items: any[], startIndex: number) {
    const replies = (data?.replies ?? []).filter((reply: any) => reply?.createItem);
    return replies.map((reply: any, i: number) => ({
      index: startIndex + i,
      itemId: reply.createItem.itemId,
      questionIds: reply.createItem.questionId,
      title: items[i]?.title ?? null,
      type: items[i]?.type ?? null,
    }));
  }

  private itemType(item: any): string {
    if (item.pageBreakItem) return 'PAGE_BREAK';
    if (item.textItem) return 'TEXT_BLOCK';
    if (item.imageItem) return 'IMAGE';
    if (item.videoItem) return 'VIDEO';
    if (item.questionGroupItem) {
      return item.questionGroupItem.grid?.columns?.type === 'CHECKBOX'
        ? 'CHECKBOX_GRID'
        : 'GRID';
    }

    const question = item.questionItem?.question;
    if (!question) return 'UNKNOWN';
    if (question.choiceQuestion) return question.choiceQuestion.type ?? 'CHOICE';
    if (question.textQuestion) return question.textQuestion.paragraph ? 'PARAGRAPH' : 'TEXT';
    if (question.scaleQuestion) return 'SCALE';
    if (question.dateQuestion) return 'DATE';
    if (question.timeQuestion) return 'TIME';
    if (question.ratingQuestion) return 'RATING';
    if (question.fileUploadQuestion) return 'FILE_UPLOAD';
    return 'UNKNOWN';
  }

  private summarizeItem(item: any, index: number) {
    const summary: any = {
      index,
      itemId: item.itemId,
      type: this.itemType(item),
      title: item.title ?? null,
    };
    if (item.description) summary.description = item.description;

    const question = item.questionItem?.question;
    if (question) {
      summary.required = question.required ?? false;
    }

    const choice = question?.choiceQuestion ?? item.questionGroupItem?.grid?.columns;
    if (choice?.options) {
      summary.options = choice.options.map((option: any) =>
        option.isOther ? `${option.value ?? ''} [other]`.trim() : option.value
      );
      const branching = choice.options
        .filter((option: any) => option.goToAction || option.goToSectionId)
        .map((option: any) => ({
          option: option.value ?? '[other]',
          goTo: option.goToAction ?? option.goToSectionId,
        }));
      if (branching.length > 0) summary.branching = branching;
    }

    if (item.questionGroupItem) {
      summary.rows = item.questionGroupItem.questions?.map(
        (row: any) => row.rowQuestion?.title
      );
    }

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private async createForm(args: any) {
    const title = this.requireString(args?.title, 'Title');

    try {
      // The create endpoint accepts info.title and info.documentTitle only;
      // description and items have to go through batchUpdate afterwards.
      const response = await this.forms.forms.create({
        requestBody: {
          info: {
            title,
            documentTitle: args.documentTitle ?? title,
          },
        },
      });

      const formId = response.data.formId;
      const requests: any[] = [];

      if (args.description) {
        requests.push({
          updateFormInfo: {
            info: { description: args.description },
            updateMask: 'description',
          },
        });
      }

      const items = args.items;
      const hasItems = Array.isArray(items) && items.length > 0;
      if (hasItems) {
        requests.push(...this.buildCreateRequests(items, 0));
      }

      let created: any[] = [];
      if (requests.length > 0) {
        const data = await this.batchUpdate(formId, requests);
        if (hasItems) {
          created = this.summarizeCreated(data, items, 0);
        }
      }

      return this.ok({
        formId,
        title,
        description: args.description ?? '',
        responderUri: response.data.responderUri,
        editUri: this.editUri(formId),
        itemsCreated: created.length,
        items: created,
      });
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      console.error('Error creating form:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create form: ${error.message}`
      );
    }
  }

  private async addItems(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');
    const items = args.items;
    const startIndex = await this.resolveIndex(formId, args.index);
    const requests = this.buildCreateRequests(items, startIndex);

    try {
      const data = await this.batchUpdate(formId, requests);
      const created = this.summarizeCreated(data, items, startIndex);

      return this.ok({
        success: true,
        message: `${created.length} item(s) added`,
        formId,
        startIndex,
        items: created,
      });
    } catch (error: any) {
      console.error('Error adding items:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to add items: ${error.message}`
      );
    }
  }

  private async addTextQuestion(args: any) {
    this.requireString(args?.formId, 'Form ID');
    this.requireString(args?.questionTitle, 'Question title');

    return await this.addItems({
      formId: args.formId,
      index: args.index,
      items: [
        {
          type: args.paragraph ? 'PARAGRAPH' : 'TEXT',
          title: args.questionTitle,
          description: args.description,
          required: args.required ?? false,
        },
      ],
    });
  }

  private async addMultipleChoiceQuestion(args: any) {
    this.requireString(args?.formId, 'Form ID');
    this.requireString(args?.questionTitle, 'Question title');

    const type = String(args.type ?? 'RADIO').toUpperCase();
    if (!CHOICE_TYPES.includes(type)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `type must be one of ${CHOICE_TYPES.join(', ')}`
      );
    }

    return await this.addItems({
      formId: args.formId,
      index: args.index,
      items: [
        {
          type,
          title: args.questionTitle,
          description: args.description,
          options: args.options,
          shuffle: args.shuffle,
          required: args.required ?? false,
        },
      ],
    });
  }

  private async addPageBreak(args: any) {
    this.requireString(args?.formId, 'Form ID');

    return await this.addItems({
      formId: args.formId,
      index: args.index,
      items: [
        {
          type: 'PAGE_BREAK',
          title: args.title,
          description: args.description,
        },
      ],
    });
  }

  private async updateItem(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');
    const index = this.requireIndex(args?.index, 'index');
    const item = this.buildItem(args?.item);
    const updateMask = args.updateMask ?? Object.keys(item).join(',');

    try {
      await this.batchUpdate(formId, [
        {
          updateItem: {
            item,
            location: { index },
            updateMask,
          },
        },
      ]);

      return this.ok({
        success: true,
        message: `Item at index ${index} updated`,
        formId,
        index,
        updateMask,
      });
    } catch (error: any) {
      console.error('Error updating item:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update item: ${error.message}`
      );
    }
  }

  private async deleteItem(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');
    const index = this.requireIndex(args?.index, 'index');

    try {
      await this.batchUpdate(formId, [
        { deleteItem: { location: { index } } },
      ]);

      return this.ok({
        success: true,
        message: `Item at index ${index} deleted`,
        formId,
        index,
      });
    } catch (error: any) {
      console.error('Error deleting item:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to delete item: ${error.message}`
      );
    }
  }

  private async moveItem(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');
    const fromIndex = this.requireIndex(args?.fromIndex, 'fromIndex');
    const toIndex = this.requireIndex(args?.toIndex, 'toIndex');

    try {
      await this.batchUpdate(formId, [
        {
          moveItem: {
            originalLocation: { index: fromIndex },
            newLocation: { index: toIndex },
          },
        },
      ]);

      return this.ok({
        success: true,
        message: `Item moved from index ${fromIndex} to ${toIndex}`,
        formId,
        fromIndex,
        toIndex,
      });
    } catch (error: any) {
      console.error('Error moving item:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to move item: ${error.message}`
      );
    }
  }

  private async updateFormInfo(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');

    const info: any = {};
    const mask: string[] = [];
    for (const field of ['title', 'description', 'documentTitle']) {
      if (args[field] !== undefined) {
        info[field] = args[field];
        mask.push(field);
      }
    }
    if (mask.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Provide at least one of title, description or documentTitle'
      );
    }

    try {
      await this.batchUpdate(formId, [
        { updateFormInfo: { info, updateMask: mask.join(',') } },
      ]);

      return this.ok({
        success: true,
        message: 'Form info updated',
        formId,
        updated: info,
      });
    } catch (error: any) {
      console.error('Error updating form info:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update form info: ${error.message}`
      );
    }
  }

  private async updateSettings(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');
    if (typeof args?.isQuiz !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'isQuiz must be a boolean');
    }

    try {
      await this.batchUpdate(formId, [
        {
          updateSettings: {
            settings: { quizSettings: { isQuiz: args.isQuiz } },
            updateMask: 'quizSettings.isQuiz',
          },
        },
      ]);

      return this.ok({
        success: true,
        message: 'Settings updated',
        formId,
        isQuiz: args.isQuiz,
      });
    } catch (error: any) {
      console.error('Error updating settings:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update settings: ${error.message}`
      );
    }
  }

  private async getForm(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');

    try {
      const response = await this.forms.forms.get({ formId });

      if (args.verbose) {
        return this.ok(response.data);
      }

      const data = response.data;
      const items = data.items ?? [];

      return this.ok({
        formId: data.formId,
        title: data.info?.title ?? null,
        description: data.info?.description ?? '',
        responderUri: data.responderUri,
        editUri: this.editUri(data.formId),
        itemCount: items.length,
        items: items.map((item: any, index: number) => this.summarizeItem(item, index)),
      });
    } catch (error: any) {
      console.error('Error getting form:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get form: ${error.message}`
      );
    }
  }

  private async getFormResponses(args: any) {
    const formId = this.requireString(args?.formId, 'Form ID');

    try {
      const response = await this.forms.forms.responses.list({ formId });

      return this.ok(response.data);
    } catch (error: any) {
      console.error('Error getting form responses:', error?.message || 'Unknown error');
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get form responses: ${error.message}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Google Forms MCP server running on stdio');
  }
}

const server = new GoogleFormsServer();
server.run().catch(console.error);
