import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

export
const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
display: flex;
flex-direction: column;
height: 100%;
background: ${theme.colors.background.primary};
font-family: ${theme.typography.fontFamily};
`,
  landingContainer: css`
display: flex;
flex-direction: column;
align-items: center;
justify-content: center;
padding: ${theme.spacing(4)} ${theme.spacing(2)};
min-height: 100%;
position: relative;
`,
  historyButton: css`
position: absolute;
top: ${theme.spacing(2)};
right: ${theme.spacing(2)};
`,
  landingContent: css`
max-width: 960px;
width: 100%;
display: flex;
flex-direction: column;
align-items: center;
gap: ${theme.spacing(4)};
`,
  header: css`
display: flex;
align-items: center;
gap: ${theme.spacing(2)};
`,
  logo: css`
display: flex;
justify-content: center;
align-items: center;
`,
  logoImage: css`
width: 120px;
height: 120px;
object-fit: contain;
`,
  title: css`
font-size: 42px;
font-weight: 700;
line-height: 1.2;
margin: 0;
`,
  subtitle: css`
font-size: 24px;
color: ${theme.colors.text.secondary};
margin: ${theme.spacing(1)} 0 0 0;
text-align: center;
`,
  badge: css`
background: #6FB31B;
color: black;
font-weight: bold;
padding: 4px 12px;
border-radius: 4px;
font-size: 12px;
letter-spacing: 1px;
`,
  description: css`
font-size: 18px;
color: ${theme.colors.text.secondary};
max-width: 600px;
text-align: center;
line-height: 1.5;
margin: 0;
`,
  landingInputWrapper: css`
width: 100%;
max-width: 800px;
background: ${theme.colors.background.secondary};
border-radius: 16px;
padding: ${theme.spacing(2)};
border: 1px solid transparent;
background-image: linear-gradient(${theme.colors.background.secondary}, ${theme.colors.background.secondary}), linear-gradient(90deg, #FF9933, #FFD633, #33C9C9, #7ACC33);
background-origin: border-box;
background-clip: padding-box, border-box;
display: flex;
flex-direction: column;
gap: ${theme.spacing(2)};
text-align: left;
`,
  landingInputHeader: css`
display: flex;
justify-content: space-between;
color: ${theme.colors.text.secondary};
font-size: 12px;
`,
  icon: css`
font-size: 24px;
`,
  iconImage: css`
height: 36px;
object-fit: contain;
`,
  landingTextArea: css`
background: transparent;
border: none;
resize: none;
font-size: 16px;
min-height: 80px;
    &:focus {
  outline: none;
  box-shadow: none;
}
`,
  landingInputFooter: css`
display: flex;
justify-content: space-between;
align-items: center;
`,
  investigationTag: css`
background: ${theme.colors.background.primary};
padding: 4px 12px;
border-radius: 12px;
font-size: 12px;
color: ${theme.colors.text.secondary};
`,
  landingActions: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
`,
  landingSendButton: css`
background: #268087;
border: none;
border-radius: 50%;
width: 32px;
height: 32px;
padding: 0;
display: flex;
align-items: center;
justify-content: center;
cursor: pointer;
transition: all 0.2s;
    
    &:hover {
  background: #ed6f3e;
  transform: scale(1.05);
}
    
    &:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`,
  footerLinks: css`
display: flex;
justify-content: space-between;
width: 100%;
max-width: 800px;
margin-top: ${theme.spacing(4)};
gap: ${theme.spacing(2)};
`,
  footerLink: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
text-align: left;
cursor: pointer;
    &:hover {
  opacity: 0.8;
}
`,
  linkTitle: css`
font-weight: bold;
font-size: 14px;
`,
  linkDesc: css`
font-size: 12px;
color: ${theme.colors.text.secondary};
`,
  messageList: css`
flex-grow: 1;
overflow-y: auto;
padding: ${theme.spacing(2)};
display: flex;
flex-direction: column;
gap: ${theme.spacing(2)};
`,
  message: css`
max-width: 80%;
padding: ${theme.spacing(1.5)};
border-radius: 12px;
font-size: ${theme.typography.body.fontSize};
transition: all 0.2s ease-out;
animation: fadeInScale 0.3s ease-out;

@keyframes fadeInScale {
      from {
    opacity: 0;
    transform: scale(0.95);
  }
      to {
    opacity: 1;
    transform: scale(1);
  }
}
`,
  userMessage: css`
align-self: flex-end;
background: linear-gradient(90deg, rgb(255, 153, 51), rgb(255, 214, 51), rgb(51, 201, 201), rgb(122, 204, 51));
color: #111217;
font-weight: 500;
border-bottom-right-radius: 2px;
`,
  assistantMessage: css`
align-self: flex-start;
background: ${theme.colors.background.secondary};
color: ${theme.colors.text.primary};
border-bottom-left-radius: 2px;
`,
  messageContent: css`
white-space: pre-wrap;
word-wrap: break-word;
transition: opacity 0.15s ease -in -out;

    /* Markdown Styles */
    p {
  margin: 0;
      &: last-child {
    margin-bottom: 0;
  }
}

h1, h2, h3, h4, h5, h6 {
  margin-top: ${theme.spacing(2)};
  margin-bottom: ${theme.spacing(2)};
  font-weight: 600;
  color: ${theme.colors.text.primary};
}
    
    h1 { font-size: 1.5em; }
    h2 { font-size: 1.3em; }
    h3 { font-size: 1.1em; }

ul, ol {
  margin: 0;
  padding-left: ${theme.spacing(3)};
}
    
    li {
  margin: 0;
  line-height: 1.5;
}
    
    code {
  background: ${theme.colors.background.primary};
  padding: 2px 4px;
  border-radius: 3px;
  font-family: ${theme.typography.fontFamilyMonospace};
  font-size: 0.9em;
}
    
    pre {
  margin: ${theme.spacing(1, 0)};
  border-radius: 4px;
  overflow: hidden;
      
      code {
    background: transparent;
    padding: 0;
    border-radius: 0;
  }
}
    
    blockquote {
  border-left: 4px solid ${theme.colors.border.strong};
  margin: ${theme.spacing(1, 0)};
  padding-left: ${theme.spacing(2)};
  color: ${theme.colors.text.secondary};
  font-style: italic;
}
    
    table {
  border-collapse: collapse;
  width: 100%;
  margin: ${theme.spacing(1, 0)};
  font-size: 0.9em;
}

th, td {
  border: 1px solid ${theme.colors.border.weak};
  padding: ${theme.spacing(1)};
  text-align: left;
}
    
    th {
  background: ${theme.colors.background.primary};
  font-weight: 600;
}
    
    a {
  color: ${theme.colors.primary.text};
  text-decoration: none;
      &:hover {
    text-decoration: underline;
  }
}
    
    img {
  max-width: 100%;
  border-radius: 4px;
}
`,
  loading: css`
align-self: flex-start;
color: ${theme.colors.text.secondary};
font-style: italic;
padding: ${theme.spacing(1)};
`,
  scrollButton: css`
position: absolute;
bottom: 120px;
left: 50%;
transform: translateX(-50%);
width: 40px;
height: 40px;
border-radius: 50%;
background: ${theme.colors.background.primary};
border: 1px solid ${theme.colors.border.weak};
box-shadow: ${theme.shadows.z2};
display: flex;
align-items: center;
justify-content: center;
cursor: pointer;
z-index: 10;
opacity: 0.8;
transition: opacity 0.2s;
    &:hover {
  opacity: 1;
  background: ${theme.colors.action.hover};
}
`,
  inputArea: css`
padding: ${theme.spacing(2)};
border-top: 1px solid ${theme.colors.border.weak};
display: flex;
flex-direction: column;
gap: ${theme.spacing(1)};
`,
  thinkingBlockWrapper: css`
margin-bottom: ${theme.spacing(1)};
border: 1px solid ${theme.colors.border.weak};
border-radius: 6px;
background: ${theme.colors.background.primary};
overflow: hidden;
`,
  thinkingHeader: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
padding: ${theme.spacing(1)};
cursor: pointer;
user-select: none;
background: ${theme.colors.background.secondary};
    &:hover {
  background: ${theme.colors.action.hover};
}
`,
  thinkingLabel: css`
color: ${theme.colors.text.secondary};
font-size: ${theme.typography.bodySmall.fontSize};
`,

  thinkingContent: css`
padding: ${theme.spacing(1.5)};
border-top: 1px solid ${theme.colors.border.weak};
font-size: ${theme.typography.bodySmall.fontSize};
color: ${theme.colors.text.secondary};
background: ${theme.colors.background.primary};
`,
  inputWrapper: css`
position: relative;
display: flex;
flex-direction: column;
align-items: stretch;
background: ${theme.colors.background.secondary};
border-radius: 16px;
padding: ${theme.spacing(2)};
border: 1px solid transparent;
background-image: linear-gradient(${theme.colors.background.secondary}, ${theme.colors.background.secondary}), linear-gradient(90deg, #FF9933, #FFD633, #33C9C9, #7ACC33);
background-origin: border-box;
background-clip: padding-box, border-box;
    
    &: focus-within {
  outline: none;
  box-shadow: none;
}

textarea:focus {
  outline: none;
  box-shadow: none;
  border: none;
}
`,
  inputWrapperLoading: css`
position: relative;
    
    &::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 19px;
  padding: 3px;
  background: linear-gradient(90deg,
    #FF9933,
    #FFD633,
        #33C9C9,
        #7ACC33,
    #FF9933
  );
  background-size: 200% 100%;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: rotateGradient 3s linear infinite;
  pointer-events: none;
  filter: blur(1px);
  opacity: 0.8;
}

@keyframes rotateGradient {
  0% {
    background-position: 0% 50%;
}
100% {
  background-position: 200% 50%;
      }
    }
`,
  textArea: css`
resize: none;
padding-right: ${theme.spacing(1.5)};
padding-left: ${theme.spacing(1.5)};
border-radius: 12px;
display: flex;
align-items: center;
padding-top: ${theme.spacing(1.5)};
padding-bottom: ${theme.spacing(1.5)};
background: transparent;
border: none;
width: 100%;
    
    &:focus {
  outline: none;
}
`,
  inputFooter: css`
display: flex;
justify-content: space-between;
align-items: center;
padding-top: ${theme.spacing(0.5)};
margin-top: ${theme.spacing(0.5)};
`,
  inputModeToggle: css`
display: flex;
gap: ${theme.spacing(0.5)};
background: ${theme.colors.background.primary};
padding: 3px;
border-radius: 8px;
border: 1px solid ${theme.colors.border.weak};
`,
  inputModeButton: css`
background: transparent;
border: none;
padding: 4px 12px;
border-radius: 6px;
font-size: 11px;
color: ${theme.colors.text.secondary};
cursor: pointer;
transition: all 0.2s;
display: flex;
align-items: center;
gap: ${theme.spacing(0.5)};
    
    &: hover: not(: disabled) {
  color: ${theme.colors.text.primary};
  background: ${theme.colors.background.secondary};
}
    
    &:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`,
  inputModeButtonActive: css`
background: ${theme.colors.background.secondary};
color: ${theme.colors.text.primary};
font-weight: 500;
`,
  inputModeButtonDisabled: css`
opacity: 0.5;
cursor: not-allowed;
`,
  inputActions: css`
display: flex;
gap: ${theme.spacing(1.5)};
align-items: center;
`,
  iconButton: css`
cursor: pointer;
color: ${theme.colors.text.secondary};
opacity: 0.7;
transition: all 0.2s;
display: flex;
align-items: center;
justify-content: center;
    
    &:hover {
  opacity: 1;
  color: ${theme.colors.text.primary};
  transform: scale(1.1);
}
    
    &.active {
  color: ${theme.colors.error.main};
  opacity: 1;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); }
}
`,
  sendIconButton: css`
cursor: pointer;
background: ${theme.colors.primary.main};
border-radius: 50%;
width: 32px;
height: 32px;
display: flex;
align-items: center;
justify-content: center;
transition: all 0.2s;
    
    &:hover {
  background: ${theme.colors.primary.shade};
  transform: scale(1.1);
}
`,
  chatHeader: css`
display: flex;
justify-content: space-between;
align-items: center;
padding: ${theme.spacing(2)};
border-bottom: 1px solid ${theme.colors.border.weak};
background: ${theme.colors.background.primary};
position: sticky;
top: 40px;
z-index: 10;
`,
  headerLeft: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
z-index: 1;
`,
  chatTitle: css`
font-size: ${theme.typography.h4.fontSize};
font-weight: ${theme.typography.fontWeightMedium};
color: ${theme.colors.text.primary};
cursor: pointer;
position: absolute;
left: 50%;
transform: translateX(-50%);
white-space: nowrap;
`,
  loadingContainer: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
padding: ${theme.spacing(1)};
color: ${theme.colors.text.secondary};
`,
  loadingIcon: css`
display: flex;
align-items: center;
color: ${theme.colors.primary.main};
`,
  loadingText: css`
font-style: italic;
font-size: 12px;
`,
  sendButton: css`
align-self: flex-end;
`,
  thinkingIndicator: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
margin-top: ${theme.spacing(0.5)};
color: ${theme.colors.text.secondary};
font-size: 12px;
font-style: italic;
`,
  thinkingDots: css`
display: flex;
align-items: center;
color: ${theme.colors.primary.main};
`,
  streamingCursor: css`
display: inline-block;
color: ${theme.colors.primary.main};
animation: blink 1s infinite;
font-size: 18px;
line-height: 1;

@keyframes blink {
  0%, 49% {
    opacity: 1;
  }
  50%, 100% {
    opacity: 0;
  }
}
`,
  codeBlockWrapper: css`
margin: 8px 0;
border-radius: 4px;
overflow: hidden;
background: ${theme.colors.background.primary};
`,
  codeBlockHeader: css`
display: flex;
align-items: center;
justify-content: space-between;
padding: 8px 12px;
background: ${theme.colors.background.primary};
border-bottom: 1px solid ${theme.colors.border.weak};
`,
  languageLabel: css`
font-size: 12px;
color: ${theme.colors.text.secondary};
font-family: ${theme.typography.fontFamilyMonospace};
text-transform: lowercase;
`,
  copyButton: css`
display: flex;
align-items: center;
gap: 4px;
background: transparent;
border: none;
color: ${theme.colors.text.secondary};
cursor: pointer;
font-size: 12px;
padding: 4px 8px;
border-radius: 4px;
transition: all 0.2s;
    
    &:hover {
  background: ${theme.colors.background.secondary};
  color: ${theme.colors.text.primary};
}
    
    svg {
  width: 14px;
  height: 14px;
}
`,
  messageCopyButton: css`
display: flex;
align-items: center;
gap: 4px;
background: transparent;
border: none;
color: ${theme.colors.text.secondary};
cursor: pointer;
font-size: 11px;
padding: 4px 0;
margin-top: 4px;
border-radius: 4px;
transition: all 0.2s;
    
    &:hover {
  color: ${theme.colors.text.primary};
}
    
    svg {
  width: 12px;
  height: 12px;
}
`,
  messageActions: css`
display: flex;
align-items: center;
gap: 8px;
margin-top: 4px;
opacity: 0.6;
transition: opacity 0.2s;
    
    &:hover {
  opacity: 1;
}
`,
  messageActionButton: css`
background: transparent;
border: none;
color: #111217;
cursor: pointer;
padding: 4px;
border-radius: 4px;
display: flex;
align-items: center;
justify-content: center;
transition: all 0.2s;
    
    &:hover {
  background: ${theme.colors.background.secondary};
  color: #FFFFFF;
}
`,
  filePreviewList: css`
display: flex;
gap: ${theme.spacing(1)};
padding: ${theme.spacing(1)};
background: ${theme.colors.background.secondary};
border-radius: 8px;
margin-bottom: ${theme.spacing(1)};
overflow-x: auto;
max-width: 100%;
width: fit-content;
`,
  filePreviewItem: css`
position: relative;
flex-shrink: 0;
background: ${theme.colors.background.primary};
border-radius: 4px;
padding: 4px;
border: 1px solid ${theme.colors.border.weak};
`,
  previewImage: css`
max-height: 60px;
border-radius: 4px;
display: block;
`,
  previewContainer: css`
display: flex;
flex-direction: column;
gap: 4px;
width: 120px;
`,
  textPreviewContent: css`
font-family: ${theme.typography.fontFamilyMonospace};
font-size: 9px;
background: ${theme.colors.background.canvas};
padding: 4px;
border-radius: 4px;
height: 60px;
overflow: hidden;
white-space: pre-wrap;
border: 1px solid ${theme.colors.border.weak};
color: ${theme.colors.text.secondary};
`,
  fileName: css`
display: flex;
align-items: center;
gap: 4px;
font-size: 10px;
color: ${theme.colors.text.primary};
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
`,
  removeFileButton: css`
position: absolute;
top: -6px;
right: -6px;
background: ${theme.colors.background.primary};
border: 1px solid ${theme.colors.border.weak};
border-radius: 50%;
cursor: pointer;
color: ${theme.colors.text.secondary};
display: flex;
align-items: center;
justify-content: center;
width: 20px;
height: 20px;
padding: 0;
box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    
    &:hover {
  color: ${theme.colors.error.text};
  border-color: ${theme.colors.error.border};
}
    
    svg {
  width: 12px;
  height: 12px;
}
`,
  warningBanner: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
background: ${theme.colors.warning.main};
color: ${theme.colors.warning.contrastText};
border-radius: 8px;
margin-bottom: ${theme.spacing(1)};
font-size: 12px;
font-weight: 500;
width: fit-content;
`,
  closeWarning: css`
background: transparent;
border: none;
cursor: pointer;
color: inherit;
display: flex;
align-items: center;
padding: 2px;
margin-left: ${theme.spacing(1)};
opacity: 0.8;
    &:hover {
  opacity: 1;
}
`,
  modeToggle: css`
display: flex;
gap: ${theme.spacing(0.5)};
background: ${theme.colors.background.primary};
padding: 2px;
border-radius: 12px;
`,
  modeButton: css`
background: transparent;
border: none;
padding: 4px 10px;
border-radius: 10px;
font-size: 12px;
color: ${theme.colors.text.secondary};
cursor: pointer;
transition: all 0.2s;
display: flex;
align-items: center;
gap: ${theme.spacing(0.5)};
    
    &: hover: not(: disabled) {
  color: ${theme.colors.text.primary};
}
`,
  modeButtonActive: css`
background: ${theme.colors.background.secondary};
color: ${theme.colors.text.primary};
font-weight: 500;
`,
  deepResearch: css`
  /* Add specific styles for deep research button if needed, or keep empty */
  `,
  modeButtonDisabled: css`
opacity: 0.5;
cursor: not-allowed;
`,
  chatModeToggle: css`
display: flex;
gap: ${theme.spacing(0.5)};
background: ${theme.colors.background.primary};
padding: 2px;
border-radius: 8px;
margin-bottom: ${theme.spacing(1)};
width: fit-content;
`,
  chatModeButton: css`
background: transparent;
border: none;
padding: 4px 12px;
border-radius: 6px;
font-size: 11px;
color: ${theme.colors.text.secondary};
cursor: pointer;
transition: all 0.2s;
display: flex;
align-items: center;
gap: ${theme.spacing(0.5)};
    
    &: hover: not(: disabled) {
  color: ${theme.colors.text.primary};
  background: ${theme.colors.background.secondary};
}
    
    &:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`,
  chatModeButtonActive: css`
background: ${theme.colors.background.secondary};
color: ${theme.colors.text.primary};
font-weight: 500;
`,
  messageImagePreviewList: css`
display: flex;
flex-wrap: wrap;
gap: ${theme.spacing(1)};
margin-top: ${theme.spacing(1)};
`,
  messageImagePreviewItem: css`
border-radius: 8px;
overflow: hidden;
border: 1px solid ${theme.colors.border.weak};
max-width: 200px;
`,
  messagePreviewImage: css`
width: 100%;
height: 100%;
object-fit: cover;
display: block;
`,
  expandIconOverlay: css`
position: absolute;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: rgba(0, 0, 0, 0.5);
display: flex;
align-items: center;
justify-content: center;
opacity: 0;
transition: opacity 0.2s ease;
cursor: pointer;
color: white;
    
    &:hover {
  opacity: 1;
}
`,
  selectionToolbar: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
`,
  selectionCount: css`
font-size: 13px;
color: ${theme.colors.text.secondary};
padding: 0 ${theme.spacing(1)};
`,
  messageSelectable: css`
display: flex;
align-items: flex-start;
gap: ${theme.spacing(1)};
`,
  messageCheckbox: css`
padding-top: ${theme.spacing(0.5)};
input[type = "checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
`,
  headerRight: css`
display: flex;
align-items: center;
gap: ${theme.spacing(1)};
`,
  toolCallsWrapper: css`
display: flex;
flex-direction: column;
gap: 8px;
margin-bottom: 12px;
width: 100%;
`,
  toolCallContainer: css`
border: 1px solid ${theme.colors.border.weak};
border-radius: 8px;
background: ${theme.colors.background.primary};
overflow: hidden;
`,
  toolCallHeader: css`
display: flex;
align-items: center;
gap: 8px;
padding: 8px 12px;
font-size: 13px;
color: ${theme.colors.text.primary};
background: ${theme.colors.background.primary};
    
    &:hover {
  background: ${theme.colors.background.secondary};
}
`,
  toolCallStatus: css`
display: flex;
align-items: center;
justify-content: center;
width: 16px;
height: 16px;
`,
  toolCallSpinner: css`
color: ${theme.colors.primary.text};
font-size: 14px;
animation: spin 1s linear infinite;
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`,
  toolCallSuccess: css`
color: ${theme.colors.success.text};
font-weight: bold;
font-size: 14px;
`,
  toolCallError: css`
color: ${theme.colors.error.text};
font-weight: bold;
font-size: 14px;
`,
  toolCallName: css`
font-family: ${theme.typography.fontFamilyMonospace};
flex: 1;
`,
  toolCallErrorDetails: css`
padding: 8px 12px;
border-top: 1px solid ${theme.colors.border.weak};
background: ${theme.colors.background.secondary};
color: ${theme.colors.error.text};
font-size: 12px;
font-family: ${theme.typography.fontFamilyMonospace};
white-space: pre-wrap;
word -break: break-word;
`,
  disclaimer: css`
text-align: center;
font-size: 12px;
color: ${theme.colors.text.secondary};
opacity: 0.7;
`,
});

