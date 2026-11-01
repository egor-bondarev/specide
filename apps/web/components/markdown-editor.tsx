'use client';

import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  InsertTable,
  InsertCodeBlock,
  Separator,
} from '@mdxeditor/editor';

interface Props {
  markdown: string;
  readOnly: boolean;
  onChange: (markdown: string) => void;
  onError: (message: string) => void;
}

export default function MarkdownEditor({
  markdown,
  readOnly,
  onChange,
  onError,
}: Props) {
  return (
    <MDXEditor
      markdown={markdown}
      readOnly={readOnly}
      contentEditableClassName="document-prose"
      placeholder="Текст требования…"
      onChange={(value, initialNormalize) => {
        if (!initialNormalize) onChange(value);
      }}
      onError={() =>
        onError(
          'Этот документ содержит неподдерживаемую разметку. Сохранение отключено, исходный файл не изменен.',
        )
      }
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        tablePlugin(),
        codeBlockPlugin({ defaultCodeBlockLanguage: 'text' }),
        codeMirrorPlugin({
          codeBlockLanguages: {
            text: 'Текст',
            json: 'JSON',
            sql: 'SQL',
            javascript: 'JavaScript',
            yaml: 'YAML',
          },
        }),
        toolbarPlugin({
          toolbarContents: () => (
            <>
              <UndoRedo />
              <Separator />
              <BlockTypeSelect />
              <Separator />
              <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />
              <Separator />
              <ListsToggle options={['bullet', 'number', 'check']} />
              <Separator />
              <CreateLink />
              <InsertTable />
              <InsertCodeBlock />
            </>
          ),
        }),
      ]}
    />
  );
}
