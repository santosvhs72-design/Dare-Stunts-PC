# Dare Stunts PC

Jogo de corridas em primeira pessoa para **browser em PC**, ao estilo do
*Stunts* (MS-DOS, 1990): loops, corkscrews, saltos e túneis, contra o relógio.

Sem dependências. Sem npm, sem frameworks, sem bibliotecas — WebGL puro para o
mundo 3D, Canvas 2D para o cockpit e Web Audio sintetizado para o som.

Derivado de [Dare Stunts TV](https://github.com/santosvhs72-design/Dare-Stunts-TV),
que por sua vez vem de [Dare Stunts](https://github.com/santosvhs72-design/Dare-Stunts).
O jogo é o mesmo: a física, as pistas, o construtor, os fantasmas e os recordes
vieram de lá inteiros e não é intenção deste repositório mexer-lhes. O que muda
é a imagem.

## Porquê um repositório à parte

A versão para televisão é **WebGL 1, um shader, um passe**, de propósito: corre
numa `WebView` de TV, onde uma tentativa de iluminação dinâmica — um único farol
e um brilho especular — chegou a ser feita e teve de ser revertida por deixar o
jogo injogável no aparelho real.

Num PC essa restrição não existe, e o que ela custava vê-se: nada assenta no
chão. As árvores, os pilares, os viadutos e o carro flutuam, porque não há uma
única sombra em lado nenhum. Este repositório é WebGL 2 e vários passes, e é
por aí que começa.

## Por onde vai

Por ordem do que mais se nota:

1. **Sombras** — shadow map direccional em cascatas. É o que falta primeiro.
2. **Iluminação por fragmento** — faróis, brilho na estrada, e túneis e
   interiores de loops verdadeiramente escuros.
3. **Anti-aliasing e pós-processamento** — o mundo é feito de faces planas e
   arestas duras, e é onde o serrilhado mais se nota.
4. **Céu e neblina melhores** — neblina por distância a sério, gradiente
   atmosférico.
5. **Efeitos** — reflexo de estrada molhada, pó nas bermas, marcas de travagem.

## Correr

Não há nada para compilar. Serve a raiz por HTTP e abre-a no browser — os
módulos ES exigem um contexto seguro, e `file://` não é um:

```sh
python3 -m http.server 8765
```

## Comandos

↑/W acelera, ↓/S trava, ←→/AD viram, Espaço é o travão de mão. Nos menus, as
setas navegam e Enter escolhe. Um comando de jogo também funciona: RT acelera,
LT trava, stick esquerdo vira, A é o travão de mão.

## Como está feito

A interface que aqui está veio inteira da versão para televisão e é
**provisória**: cartões grandes, navegação por cruzeta, uma escolha por ecrã.
Está desenhada para se ver do sofá e vai ser substituída por uma de rato e
teclado. Ficou como estava de propósito — enquanto o trabalho é todo sobre a
imagem, convém que tudo o resto seja igual ao que já existe, para se poder pôr
as duas versões lado a lado e ver só a diferença que interessa.
