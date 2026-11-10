# Security policy

imagefast parses image files that an application's users choose, with its own header and PSD parsers and with
bundled decoders (LibRaw, libheif, UTIF). A file that crashes a worker, hangs a decode, reads out of bounds or
produces another file's pixels is a security bug here, not just a decode failure.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on
https://github.com/smart-byte/imagefast (a private security advisory). Do not open a public issue for it.

Include the imagefast version, the browser, and a file or the steps that reproduce the problem.

## Scope

- Supported: the latest released version.
- Bugs in LibRaw, libheif or UTIF themselves are best reported upstream as well; imagefast ships LibRaw 0.22.1,
  libheif-js 1.23.5 and UTIF 3.1.0, and picks up their fixes with a rebuild.
- All decoding runs inside the browser sandbox (WebAssembly or JavaScript in a worker). There is no server
  component and nothing is uploaded.
