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

Num PC essa restrição não existe, e o que ela custava via-se: nada assentava no
chão. As árvores, os pilares, os viadutos e o carro flutuavam, porque não havia
uma única sombra em lado nenhum. Aqui é WebGL 2 e vários passes.

## Por onde vai

Por ordem do que mais se nota:

1. ~~**Sombras**~~ — feito: shadow map direccional em dois mapas.
2. ~~**Iluminação por fragmento**~~ — feito: faróis, brilho de sol na estrada, e
   túneis e interiores de loops verdadeiramente escuros.
3. **Anti-aliasing e pós-processamento** — o mundo é feito de faces planas e
   arestas duras, e é onde o serrilhado mais se nota. Falta o tone map, o
   *bloom* e o FXAA; o multisampling já lá está.
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

O `Renderer` recebe uma **descrição da cena**, não uma sequência de chamadas.
Na versão para televisão o `Game.render` desenhava — `beginFrame` e depois um
`draw` por grupo — e o renderer nunca via a cena inteira. Um mapa de sombras
tem de percorrer a mesma geometria outra vez, de outro sítio, antes de alguma
coisa chegar ao ecrã, por isso a lista do que há para desenhar tem de existir
antes de o desenho começar. É a única coisa que o motor de jogo cedeu.

Um frame são quatro andares: os dois mapas de sombras, a cena para um buffer
`RGBA16F` com quatro amostras, a resolução dessas amostras, e a composição no
ecrã. O multisampling é pedido à mão porque um browser só multisamplia a
imagem que mostra directamente, e a partir do momento em que o frame é
construído por etapas essa imagem é uma textura.

Quatro decisões que não são óbvias e que é bom não desfazer sem saber porquê:

- **Há um único preâmbulo de GLSL, `highp` nos dois estágios, à cabeça de todos
  os shaders.** É estrutural, não zelo: um uniform lido pelos dois estágios tem
  de ser declarado com a mesma precisão nos dois ou o programa recusa-se a
  ligar, e nada na mensagem de erro diz isso. Um vertex shader sem directiva
  `precision` própria é `highp` por omissão da linguagem, um fragment shader
  que diga `mediump` não é, e foi assim que a versão para televisão perdeu uma
  tarde. Com um preâmbulo só não sobra nenhuma declaração que possa discordar
  de outra.
- **O piso ambiente é baixo, e o sol soma-se por cima dele.** A fórmula
  herdada somava o sol *dentro* de um piso alto, o que deixava uma superfície
  ao sol e a mesma sem sol nenhum a 11% uma da outra. Servia para um mundo sem
  sombras, onde o trabalho era tudo continuar legível; num mundo com sombras
  não sobra nada para a sombra fazer. Ao sol a imagem está a poucos por cento
  de onde sempre esteve, à sombra um terço abaixo — e o interior de um loop e
  o furo de um túnel, onde o sol nunca chegou, ficaram muito mais escuros de
  propósito. É por isso que os faróis tinham de existir primeiro.
- **A caixa de cada mapa de sombras é arredondada a texels inteiros.** Sem
  isso desliza uma fracção de texel por frame enquanto o carro anda, cada
  aresta é redesenhada contra uma grelha diferente, e o mundo inteiro ferve.
- **Os termos de luz novos iluminam o lado da face virado para a câmara; os
  antigos continuam a ler a normal como sempre leram.** O culling está
  desligado de propósito — a fita conduz-se dos dois lados — e o sentido da
  normal de um quad é o que o construtor da malha lhe deu, que para o arco de
  um túnel muda a meio. Ao sol isso era indiferente; a uma lâmpada a dois
  metros da parede não é.

Para desenvolver, vale a pena servir com `Cache-Control: no-store`: os módulos
ES ficam em cache com muita vontade, e uma alteração a um shader que o browser
não recarrega é meia hora a perseguir um bug que já está corrigido.

`window.__game()` entrega o jogo a quem o queira conduzir de fora. Comparar
duas versões da mesma imagem exige chegar duas vezes exactamente ao mesmo
sítio da pista, e a conduzir à mão isso não acontece. As vistas de referência
usadas até agora são da Costa Verde: a recta com as árvores aos 100 m, a
entrada do túnel aos 470, e a rampa do loop aos 2080.
